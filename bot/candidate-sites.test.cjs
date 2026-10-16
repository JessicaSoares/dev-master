const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identify, prepare, runQueue } = require('./engine.cjs');
const { buildHandoff } = require('./candidate-sites.cjs');
const profile = { name: 'Candidata teste', email: 'test@example.invalid', about: 'Experiência real', projects: 'Projeto demonstrável' };

test('Indeed conserva o identificador de vaga e elimina rastreamento', () => {
  const url = 'https://br.indeed.com/viewjob?jk=abc123456789abcd&from=alert';
  assert.equal(identify(url).canonical, 'https://br.indeed.com/viewjob?jk=abc123456789abcd');
  const q = prepare(profile, [{ url }, { url: 'https://www.indeed.com/jobs?vjk=abc123456789abcd' }]);
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].target.automaticSubmission, false);
});
test('InfoJobs deduplica ID mesmo com slug diferente', () => {
  const q = prepare(profile, [{ url: 'https://infojobs.com.br/vaga-a__12345.aspx?ref=x' }, { url: 'https://www.infojobs.com.br/vaga-b__12345.aspx' }]);
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].target.platform, 'infojobs');
});
test('Gupy reconhece vaga da empresa e não confunde login com vaga', () => {
  assert.equal(identify('https://empresa.gupy.io/jobs/123?jobBoardSource=x').canonical, 'https://empresa.gupy.io/jobs/123');
  assert.equal(identify('https://login.gupy.io/jobs/123').needsJobLink, true);
  assert.equal(identify('https://gupy.io.evil.invalid/jobs/123').platform, 'other');
  assert.equal(identify('https://www.infojobs.com.br.evil.invalid/x__123.aspx').platform, 'other');
});
test('link de busca exige vaga individual e não ganha status de enviada', async () => {
  const q = prepare(profile, [{ url: 'https://br.indeed.com/jobs?q=frontend' }]);
  assert.equal(q.items[0].target.needsJobLink, true);
  Object.assign(q.items[0], { approved: true, requiredFieldsVerified: true });
  await runQueue(q, { send: true, fetcher: () => assert.fail('Nenhuma rede') });
  assert.equal(q.items[0].status, 'manual_required');
  assert(buildHandoff(q).includes('não identifica uma vaga individual'));
});
test('três plataformas preparam dados reais sem efetuar POST', async () => {
  const q = prepare(profile, [
    { title: 'Frontend', url: 'https://br.indeed.com/viewjob?jk=abc123456789abcd' },
    { title: 'Backend', url: 'https://www.infojobs.com.br/backend__12345.aspx' },
    { title: 'Full stack', url: 'https://empresa.gupy.io/jobs/123' },
  ]);
  q.items.forEach(item => Object.assign(item, { approved: true, requiredFieldsVerified: true }));
  await runQueue(q, { send: true, fetcher: () => assert.fail('Não há integração de envio autorizada') });
  assert(q.items.every(item => item.status === 'manual_required'));
  const packet = buildHandoff(q);
  assert(packet.includes('Experiência real\n\nProjeto demonstrável'));
  assert(packet.includes('Indeed') && packet.includes('InfoJobs') && packet.includes('Gupy'));
  assert(packet.includes('envio não confirmado'));
});
