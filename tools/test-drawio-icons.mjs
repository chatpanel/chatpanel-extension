import assert from 'node:assert/strict';
import { resolveDrawioStyle, isIconShorthand, applyIconShorthand, AWS_RESICON } from '../extension/js/drawio-icons.js';

// ── shorthand detection ──
assert.equal(isIconShorthand('aws:ec2'), true);
assert.equal(isIconShorthand('gcp:compute_engine'), true);
assert.equal(isIconShorthand('shape=mxgraph.aws4.resourceIcon;resIcon=…;'), false); // full style
assert.equal(isIconShorthand('rounded=1;whiteSpace=wrap;'), false);
assert.equal(isIconShorthand(''), false);

// ── AWS resolution: exact resIcon names, incl. the ones that differ from the friendly name ──
const ec2 = resolveDrawioStyle('aws:ec2');
assert.match(ec2, /shape=mxgraph\.aws4\.resourceIcon;/);
assert.match(ec2, /resIcon=mxgraph\.aws4\.ec2;/);
assert.match(ec2, /aspect=fixed/);
assert.match(resolveDrawioStyle('aws:s3'), /resIcon=mxgraph\.aws4\.simple_storage_service;/);
assert.match(resolveDrawioStyle('aws:elb'), /resIcon=mxgraph\.aws4\.elastic_load_balancing;/);
assert.match(resolveDrawioStyle('aws:route53'), /resIcon=mxgraph\.aws4\.route_53;/);
assert.match(resolveDrawioStyle('aws:iam'), /resIcon=mxgraph\.aws4\.identity_and_access_management;/);
// case / separator tolerance
assert.match(resolveDrawioStyle('AWS:Route 53'), /resIcon=mxgraph\.aws4\.route_53;/);
// unknown AWS service → snake-cased passthrough (still a valid aws4 attempt)
assert.match(resolveDrawioStyle('aws:some_new_service'), /resIcon=mxgraph\.aws4\.some_new_service;/);

// ── category colours ──
assert.match(resolveDrawioStyle('aws:ec2'), /fillColor=#ED7100/);      // compute orange
assert.match(resolveDrawioStyle('aws:s3'), /fillColor=#7AA116/);       // storage green
assert.match(resolveDrawioStyle('aws:rds'), /fillColor=#C925D1/);      // database magenta
assert.match(resolveDrawioStyle('aws:vpc'), /fillColor=#8C4FFF/);      // networking purple
assert.match(resolveDrawioStyle('aws:iam'), /fillColor=#DD344C/);      // security red

// ── other providers → generic stencil passthrough ──
assert.match(resolveDrawioStyle('gcp:compute_engine'), /shape=mxgraph\.gcp2\.compute_engine;/);
assert.match(resolveDrawioStyle('azure:virtual_machine'), /shape=mxgraph\.azure\.virtual_machine;/);
assert.match(resolveDrawioStyle('k8s:pod'), /shape=mxgraph\.kubernetes\.pod;/);

// ── a full style passes through unchanged ──
const full = 'shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;aspect=fixed;';
assert.equal(resolveDrawioStyle(full), full);

// ── applyIconShorthand on a node skeleton ──
const a = applyIconShorthand({ id: 'x', icon: 'aws:ec2', x: 10, y: 20, text: 'Web' });
assert.match(a.style, /resIcon=mxgraph\.aws4\.ec2;/);
assert.equal(a.width, 78); assert.equal(a.height, 78);
assert.equal(a.icon, undefined); // consumed
assert.equal(a.text, 'Web');     // untouched
// style-as-shorthand also works
assert.match(applyIconShorthand({ style: 'aws:s3' }).style, /simple_storage_service/);
// a plain node is untouched
const plain = { id: 'y', type: 'rounded', x: 0, y: 0, text: 'Start' };
assert.deepEqual(applyIconShorthand(plain), plain);
// a node with an explicit full style is untouched
const styled = { id: 'z', style: 'rounded=1;whiteSpace=wrap;html=1;' };
assert.deepEqual(applyIconShorthand(styled), styled);

// sanity: the catalog has the well-known aliases
for (const k of ['ec2', 's3', 'rds', 'lambda', 'iam', 'vpc', 'sqs', 'sns', 'dynamodb']) {
  assert.ok(AWS_RESICON[k], `AWS catalog missing ${k}`);
}

console.log('drawio-icons tests passed');
