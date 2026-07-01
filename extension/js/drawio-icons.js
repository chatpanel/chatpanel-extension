// draw.io icon shorthands → full mxGraph styles. The model can say `icon:"aws:ec2"`
// instead of memorizing the exact `resIcon=mxgraph.aws4.*` names (many differ from the
// service's friendly name — s3 → simple_storage_service, elb → elastic_load_balancing).
// Pure + dependency-free so it's unit-testable and reusable.

// Friendly AWS shorthand → the exact mxgraph.aws4 resIcon name. Keys are separator-free
// and lowercased; the resolver normalizes input to match.
export const AWS_RESICON = {
  // compute
  ec2: 'ec2', lambda: 'lambda', ecs: 'elastic_container_service', eks: 'elastic_kubernetes_service',
  fargate: 'fargate', batch: 'batch', lightsail: 'lightsail', beanstalk: 'elastic_beanstalk',
  ecr: 'elastic_container_registry', autoscaling: 'ec2_auto_scaling',
  // storage
  s3: 'simple_storage_service', ebs: 'elastic_block_store', efs: 'elastic_file_system',
  glacier: 'simple_storage_service_glacier', backup: 'backup', storagegateway: 'storage_gateway', fsx: 'fsx',
  // database
  rds: 'rds', dynamodb: 'dynamodb', aurora: 'aurora', elasticache: 'elasticache',
  redshift: 'redshift', documentdb: 'documentdb', neptune: 'neptune', timestream: 'timestream',
  // networking & content delivery
  vpc: 'virtual_private_cloud_vpc', cloudfront: 'cloudfront', route53: 'route_53',
  elb: 'elastic_load_balancing', alb: 'elastic_load_balancing_application_load_balancer',
  apigateway: 'api_gateway', directconnect: 'direct_connect', transitgateway: 'transit_gateway',
  privatelink: 'privatelink', globalaccelerator: 'global_accelerator',
  // management & governance
  cloudwatch: 'cloudwatch', cloudtrail: 'cloudtrail', cloudformation: 'cloudformation',
  ssm: 'systems_manager', config: 'config', organizations: 'organizations', controltower: 'control_tower',
  // security, identity & compliance
  iam: 'identity_and_access_management', cognito: 'cognito', kms: 'key_management_service',
  secretsmanager: 'secrets_manager', waf: 'waf_web_application_firewall', shield: 'shield',
  guardduty: 'guardduty', securityhub: 'security_hub', acm: 'certificate_manager',
  // application integration
  sqs: 'simple_queue_service', sns: 'simple_notification_service', eventbridge: 'eventbridge',
  stepfunctions: 'step_functions', appsync: 'appsync', mq: 'mq',
  // analytics
  glue: 'glue', athena: 'athena', kinesis: 'kinesis', emr: 'emr', quicksight: 'quicksight',
  opensearch: 'opensearch_service', msk: 'managed_streaming_for_apache_kafka',
  // ai / ml
  sagemaker: 'sagemaker', bedrock: 'bedrock', rekognition: 'rekognition', comprehend: 'comprehend',
  textract: 'textract', polly: 'polly', translate: 'translate',
  // developer tools & front-end
  amplify: 'amplify', codebuild: 'codebuild', codepipeline: 'codepipeline', codecommit: 'codecommit',
  cloud9: 'cloud9', appconfig: 'appconfig',
  // generic
  user: 'user', users: 'users', client: 'client', internet: 'internet_gateway',
};

// Category tile colours (approximate official AWS palette) so shorthands render on the
// right-coloured tile.
function awsColor(k) {
  if (/^(s3|ebs|efs|glacier|backup|storagegateway|fsx)/.test(k)) return '#7AA116'; // storage green
  if (/^(rds|dynamodb|aurora|elasticache|redshift|documentdb|neptune|timestream)/.test(k)) return '#C925D1'; // database magenta
  if (/^(vpc|cloudfront|route53|elb|alb|apigateway|directconnect|transitgateway|privatelink|globalaccelerator)/.test(k)) return '#8C4FFF'; // networking purple
  if (/^(iam|cognito|kms|secretsmanager|waf|shield|guardduty|securityhub|acm)/.test(k)) return '#DD344C'; // security red
  if (/^(cloudwatch|cloudtrail|cloudformation|ssm|config|organizations|controltower)/.test(k)) return '#E7157B'; // management pink
  if (/^(sagemaker|bedrock|rekognition|comprehend|textract|polly|translate|glue|athena|kinesis|emr|quicksight|opensearch|msk)/.test(k)) return '#01A88D'; // analytics/ml teal
  return '#ED7100'; // compute / default orange
}

const PROVIDER_STENCIL = { gcp: 'gcp2', azure: 'azure', k8s: 'kubernetes', kubernetes: 'kubernetes' };

// Is this token a shorthand ("provider:name") rather than a full mxGraph style?
export function isIconShorthand(token) {
  return /^[a-z0-9]+:[a-z0-9_.\- ]+$/i.test(String(token || '').trim());
}

// Resolve an icon shorthand ("aws:ec2", "gcp:compute_engine", …) to a full draw.io style.
// A token that is already a full style (contains ';' or a non-shorthand '=') is returned
// unchanged, so callers can pass either.
export function resolveDrawioStyle(token) {
  const s = String(token || '').trim();
  if (!s || !isIconShorthand(s)) return s;
  const [, provider, rawName] = s.match(/^([a-z0-9]+):([a-z0-9_.\- ]+)$/i);
  const p = provider.toLowerCase();
  const key = rawName.toLowerCase().replace(/[\s.\-_]/g, '');
  const snake = rawName.toLowerCase().trim().replace(/[\s.\-]+/g, '_');
  if (p === 'aws') {
    const resIcon = AWS_RESICON[key] || snake;
    return `sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=${awsColor(key)};`
      + 'strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;'
      + `fontSize=11;fontStyle=0;aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.${resIcon};`;
  }
  const stencil = PROVIDER_STENCIL[p] || p;
  return `sketch=0;html=1;aspect=fixed;verticalLabelPosition=bottom;verticalAlign=top;align=center;`
    + `shape=mxgraph.${stencil}.${snake};`;
}

// Apply the shorthand to a node skeleton: an `icon` field (preferred) or a `style` that is
// itself a shorthand → the resolved full style + a sensible default icon size.
export function applyIconShorthand(el) {
  if (!el || typeof el !== 'object') return el;
  if (el.icon && isIconShorthand(el.icon)) {
    return { ...el, style: resolveDrawioStyle(el.icon), width: el.width || 78, height: el.height || 78, icon: undefined };
  }
  if (typeof el.style === 'string' && isIconShorthand(el.style)) {
    return { ...el, style: resolveDrawioStyle(el.style), width: el.width || 78, height: el.height || 78 };
  }
  return el;
}
