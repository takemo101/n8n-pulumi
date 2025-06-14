import * as command from '@pulumi/command';
import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

// -----------------------------
// 設定値 Pulumi.xxx.yaml から取得
// -----------------------------
const config = new pulumi.Config();
const projectId = config.require('projectId');
const region = config.require('region');
// Supabaseのパスワードはセキュアな値として設定することを推奨します。
// Pulumiだと以下のコマンドで設定できます:
// pulumi config set --secret supabasePassword YOUR_SUPABASE_PASSWORD
const supabasePassword = config.requireSecret('supabasePassword');
const supabaseHost = config.require('supabaseHost');
const supabasePort = config.require('supabasePort');
const supabaseDatabase = config.require('supabaseDatabase');
const supabaseUser = config.require('supabaseUser');

// -----------------------------
// APIの有効化
// -----------------------------
const apis = ['run', 'secretmanager'].map(
  (api) =>
    new gcp.projects.Service(`enable-${api}`, {
      project: projectId,
      service: `${api}.googleapis.com`,
      disableDependentServices: true, // サービスの依存関係を無効にする
    }),
);

// -----------------------------
// サービスアカウント作成
// -----------------------------
const n8nServiceAccount = new gcp.serviceaccount.Account(
  'n8n-service-account',
  {
    accountId: 'n8n-service-account',
    displayName: 'n8n Service Account',
    project: gcp.config.project,
  },
);

// -----------------------------
// シークレット作成
// -----------------------------
// Supabaseのパスワードを格納するシークレットを作成
const dbPasswordSecret = new gcp.secretmanager.Secret(
  'db-password-secret',
  {
    secretId: 'supabase-db-password',
    replication: {
      auto: {}, // 自動レプリケーションを使用
    },
  },
  {
    dependsOn: apis,
  },
);
new gcp.secretmanager.SecretVersion('db-password-secret-version', {
  secret: dbPasswordSecret.id,
  secretData: supabasePassword, // ここに実際のパスワードを設定
});

// n8nの暗号化キーを格納するシークレットを作成
const n8nEncryptionKeySecret = new gcp.secretmanager.Secret(
  'n8n-encryption-key-secret',
  {
    secretId: 'n8n-encryption-key',
    replication: {
      auto: {}, // 自動レプリケーションを使用
    },
  },
  {
    dependsOn: apis,
  },
);
// n8nの暗号化キーをランダム生成
const n8nEncryptionKeyRandom = new random.RandomString(
  'n8n-encryption-key-random',
  {
    length: 32,
    special: false,
  },
);
new gcp.secretmanager.SecretVersion('n8n-encryption-key-secret-version', {
  secret: n8nEncryptionKeySecret.id,
  secretData: n8nEncryptionKeyRandom.result,
});

// -----------------------------
// Cloud Run サービス作成
// -----------------------------
const n8nService = new gcp.cloudrunv2.Service('n8n-service', {
  name: 'n8n-supabase-service',
  location: region,
  deletionProtection: false,
  template: {
    serviceAccount: n8nServiceAccount.email,
    scaling: {
      minInstanceCount: 1,
      maxInstanceCount: 5,
    },
    containers: [
      {
        image: 'n8nio/n8n:latest',
        ports: {
          containerPort: 5678,
        },
        resources: {
          limits: {
            cpu: '1',
            memory: '1Gi',
          },
        },
        envs: [
          // Supabaseの接続情報を環境変数として設定
          { name: 'DB_TYPE', value: 'postgresdb' },
          { name: 'DB_POSTGRESDB_HOST', value: supabaseHost },
          { name: 'DB_POSTGRESDB_PORT', value: supabasePort },
          { name: 'DB_POSTGRESDB_DATABASE', value: supabaseDatabase },
          { name: 'DB_POSTGRESDB_USER', value: supabaseUser },
          { name: 'DB_POSTGRESDB_SSL', value: 'true' },
          {
            name: 'DB_POSTGRESDB_PASSWORD',
            valueSource: {
              secretKeyRef: {
                secret: dbPasswordSecret.secretId,
                version: 'latest',
              },
            },
          },
          // その他n8nの設定
          { name: 'GENERIC_TIMEZONE', value: 'Asia/Tokyo' },
          {
            name: 'N8N_ENCRYPTION_KEY',
            valueSource: {
              secretKeyRef: {
                secret: n8nEncryptionKeySecret.secretId,
                version: 'latest',
              },
            },
          },
          { name: 'N8N_USER_MANAGEMENT_DISABLED', value: 'true' },
          // WEBHOOK_URL と N8N_EDITOR_BASE_URL は後ほど command.local.Command で設定
        ],
      },
    ],
  },
});

// -----------------------------
// Cloud Run サービスの URI を取得して環境変数を設定
// -----------------------------
const envVarsForServiceUri = ['WEBHOOK_URL', 'N8N_EDITOR_BASE_URL'];

// Cloud Run サービスの URI が確定した後にコマンドを実行
// n8nService.uri は Output<string> なので、apply を使って値を取得
n8nService.uri.apply((uri) => {
  const envVarsString = envVarsForServiceUri
    .map((envName) => `${envName}=${uri}`)
    .join(',');
  const gcloudCommand = pulumi.interpolate`gcloud run services update ${n8nService.name} \\
  --project=${projectId} \\
  --region=${region} \\
  --set-env-vars=${envVarsString} \\
  --format=none`;

  return new command.local.Command(
    'update-n9n-env-vars',
    {
      create: gcloudCommand,
      interpreter: ['bash', '-c'],
    },
    { dependsOn: [n8nService] },
  );
});

// -----------------------------
// IAM ポリシーの設定
// -----------------------------
// Cloud Runを公開アクセス可能にする
new gcp.cloudrunv2.ServiceIamMember('n8n-invoker', {
  project: n8nService.project,
  location: n8nService.location,
  name: n8nService.name,
  role: 'roles/run.invoker',
  member: 'allUsers',
});

// Cloud RunのサービスアカウントがSecret Managerを読み取れるようにする
new gcp.secretmanager.SecretIamMember('db-password-accessor', {
  project: dbPasswordSecret.project,
  secretId: dbPasswordSecret.secretId,
  role: 'roles/secretmanager.secretAccessor',
  member: pulumi.interpolate`serviceAccount:${n8nServiceAccount.email}`,
});

new gcp.secretmanager.SecretIamMember('encryption-key-accessor', {
  project: n8nEncryptionKeySecret.project,
  secretId: n8nEncryptionKeySecret.secretId,
  role: 'roles/secretmanager.secretAccessor',
  member: pulumi.interpolate`serviceAccount:${n8nServiceAccount.email}`,
});

// -----------------------------
// 出力
// -----------------------------
export const n8nServiceUrl = n8nService.uri;
export const n8nServiceAccountEmail = n8nServiceAccount.email;
