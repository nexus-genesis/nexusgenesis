// tests/test-audit-panel.js
// Verify the audit panel HTML structure
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS:', msg); }
  else { failed++; console.error('  FAIL:', msg); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

console.log('\n=== Test 1: HTML structure contains audit panel ===');
assert(html.includes('id="auditList"'), 'auditList element present');
assert(html.includes('id="auditTotalCount"'), 'auditTotalCount element present');
assert(html.includes('Live Audit Trail'), 'panel title present');

console.log('\n=== Test 2: JavaScript functions defined ===');
assert(html.includes('async function loadAuditTrail'), 'loadAuditTrail function defined');
assert(html.includes('function auditBadge'), 'auditBadge helper defined');
assert(html.includes('function shortAddr'), 'shortAddr helper defined');
assert(html.includes('AUDIT_TYPE_COLORS'), 'audit color map defined');

console.log('\n=== Test 3: Auto-refresh interval configured ===');
assert(html.includes('setInterval(loadAuditTrail, 15000)'), '15s auto-refresh interval set');

console.log('\n=== Test 4: Supported audit event types in color map ===');
const expectedTypes = ['TASK_ESCROW', 'TASK_REWARD', 'TASK_REFUND', 'CHALLENGE_DEPOSIT', 'OBSERVER_EVENT', 'TRANSFER', 'BLOCK_REWARD'];
for (const t of expectedTypes) {
  assert(html.includes(`'${t}'`), `color mapping for ${t}`);
}

console.log('\n=== Test 5: Script invokes loadAuditTrail on load ===');
assert(html.includes('loadAuditTrail();'), 'loadAuditTrail called on script load');

console.log('\n=== Test 6: Element placement between stats and recruitment ===');
const statsPos = html.indexOf('Block Height');
const auditPos = html.indexOf('Live Audit Trail');
const recruitPos = html.indexOf('Constitution v1.2.0');
assert(statsPos > 0, 'stats bar present');
assert(auditPos > statsPos, 'audit panel after stats bar');
assert(recruitPos > auditPos, 'recruitment banner after audit panel');

console.log('\n=== Test 7: Panel uses glass styling ===');
const panelSection = html.substring(html.indexOf('<!-- AUDIT EVENTS PANEL'), html.indexOf('<!-- V1.2.0'));
assert(panelSection.includes('glass rounded-xl'), 'panel uses glass card styling');
assert(panelSection.includes('pulse'), 'live indicator with pulse animation');
assert(panelSection.includes('max-h-80'), 'scrollable container with max height');

console.log('\n=== Test 8: Fetches from correct endpoint ===');
assert(html.includes("/api/v1/transactions?limit=20"), 'fetches from /api/v1/transactions?limit=20');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
