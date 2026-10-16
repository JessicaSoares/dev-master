const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identify, prepare, runQueue, discoverLever } = require('./engine.cjs');
const url = 'https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc';
const profile = { name: 'Candidata de teste', email: 'test@example.invalid' };
const queue = () => prepare(profile, [{ url }]);
const approved = () => { const q = queue(); Object.assign(q.items[0], { approved: true, requiredFieldsVerified: true }); return q; };
const response = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: new Headers(headers) });
const options = { send: true, env: { LEVER_KEY_EXAMPLE: 'fake-test-key' }, delay: async () => {} };

test('deduplica URLs Lever e rejeita destinos não HTTPS ou com credenciais', () => {
  assert.equal(prepare(profile, [{ url }, { url: url + '/apply?ref=abc#x' }]).items.length, 1);
  assert.throws(() => identify('http://localhost/'));
  assert.throws(() => identify('https://user:pass@jobs.lever.co/x/y'));
  assert.equal(identify('https://linkedin.com.evil.invalid/jobs').platform, 'other');
  assert.equal(identify('https://www.linkedin.com/jobs/view/1').capability, 'manual');
});
test('aprovação e credencial são pré-requisitos; simulação não envia', async () => {
  let calls = 0; const fetcher = async () => { calls++; throw new Error('não esperado'); };
  const q = queue(); await runQueue(q, { ...options, fetcher }); assert.equal(q.items[0].status, 'pending_review');
  const missing = approved(); await runQueue(missing, { ...options, env: {}, fetcher }); assert.equal(missing.items[0].status, 'credential_required');
  const dry = approved(); await runQueue(dry, { ...options, send: false, fetcher }); assert.equal(dry.items[0].status, 'ready');
  assert.equal(calls, 0);
});
test('somente comprovante explícito permite submitted, e não repete envio', async () => {
  let calls = 0; const q = approved(); const states = [];
  const fetcher = async (target, req) => { calls++; assert(target.startsWith('https://api.lever.co/v0/postings/example/')); assert.equal(req.method, 'POST'); assert.equal(req.body.get('name'), profile.name); return response(200, { ok: true, applicationId: 'receipt-1' }); };
  await runQueue(q, { ...options, fetcher, persist: value => states.push(value.items[0].status) });
  assert.deepEqual(states, ['sending', 'submitted']); assert.equal(q.items[0].receipt.applicationId, 'receipt-1');
  await runQueue(q, { ...options, fetcher }); assert.equal(calls, 1);
});
test('timeout e sucesso sem comprovante ficam incertos e não repetem', async () => {
  for (const fetcher of [async () => { throw new Error('timeout secret'); }, async () => response(200, { ok: true }), async () => response(500, {})]) {
    const q = approved(); await runQueue(q, { ...options, fetcher }); assert.equal(q.items[0].status, 'uncertain');
    await runQueue(q, { ...options, fetcher: () => assert.fail('Não repetir resultado incerto') });
    assert(!JSON.stringify(q).includes('secret'));
  }
});
test('429 respeita Retry-After e permite retomada apenas depois do prazo', async () => {
  const q = approved(); const now = 1000000000000;
  await runQueue(q, { ...options, now: () => now, fetcher: async () => response(429, {}, { 'retry-after': '120' }) });
  assert.equal(q.items[0].status, 'rate_limited'); assert.equal(Date.parse(q.items[0].retryAt), now + 120000);
  await runQueue(q, { ...options, now: () => now + 60000, fetcher: () => assert.fail('Aguardar prazo') });
  await runQueue(q, { ...options, now: () => now + 121000, fetcher: async () => response(200, { ok: true, applicationId: 'retry-receipt' }) });
  assert.equal(q.items[0].status, 'submitted'); assert.equal(q.items[0].attempts, 2);
});
test('rejeição explícita não é sucesso, destino alterado não envia', async () => {
  const q = approved(); await runQueue(q, { ...options, fetcher: async () => response(400, { ok: false }) }); assert.equal(q.items[0].status, 'failed');
  const tampered = approved(); tampered.items[0].target.canonical = 'https://evil.invalid/';
  await runQueue(tampered, { ...options, fetcher: () => assert.fail('Destino alterado') }); assert.equal(tampered.items[0].status, 'invalid');
});
test('simulação valida destino e currículo antes de indicar prontidão', async () => {
  const q = approved(); q.items[0].resumePath = 'arquivo-que-nao-existe.pdf';
  await runQueue(q, { ...options, send: false, fetcher: () => assert.fail('Sem rede') });
  assert.equal(q.items[0].status, 'invalid');
  const tampered = approved(); tampered.items[0].target.canonical = 'https://evil.invalid/';
  await runQueue(tampered, { ...options, send: false }); assert.equal(tampered.items[0].status, 'invalid');
});
test('canais sem conector seguem para ação manual', async () => {
  const q = prepare(profile, [{ url: 'https://www.linkedin.com/jobs/view/1' }]); Object.assign(q.items[0], { approved: true, requiredFieldsVerified: true });
  await runQueue(q, { ...options, fetcher: () => assert.fail('Sem envio') }); assert.equal(q.items[0].status, 'manual_required');
});
test('descoberta consulta somente endpoint fixo e normaliza a resposta', async () => {
  const jobs = await discoverLever('example', 'global', async target => { assert.equal(target, 'https://api.lever.co/v0/postings/example?mode=json&limit=100&skip=0'); return response(200, [{ hostedUrl: url, text: 'Frontend', categories: { location: 'Brazil' }, descriptionPlain: 'React' }]); });
  assert.equal(jobs[0].title, 'Frontend'); assert.equal(jobs[0].url, url);
  await assert.rejects(discoverLever('../invalid'));
});
