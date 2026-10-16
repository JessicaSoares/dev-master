const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identify, prepare, runQueue } = require('./engine.cjs');
const { discoverGreenhouse, inspectGreenhouse, validateAnswers } = require('./greenhouse.cjs');
const url = 'https://boards.greenhouse.io/example/jobs/123';
const question = (label, required, fields) => ({ label, required, fields });
const field = (name, type = 'input_text', values = []) => ({ name, type, values });
const form = { questions: [question('First name', true, [field('first_name')]), question('Resume', true, [field('resume', 'input_file'), field('resume_text', 'textarea')]), question('Work authorization', true, [field('question_1', 'multi_value_single_select', [{ value: 0 }, { value: 1 }])])], dataCompliance: [], demographicQuestions: null };

test('Greenhouse aliases e parâmetros de rastreamento são deduplicados', () => {
  assert.equal(identify(url).canonical, 'https://job-boards.greenhouse.io/example/jobs/123');
  const q = prepare({ name: 'Teste', email: 'test@example.invalid' }, [{ url }, { url: 'https://job-boards.greenhouse.io/example/jobs/123?gh_src=abc#app' }]);
  assert.equal(q.items.length, 1);
  assert.equal(identify('https://boards.greenhouse.io/example/jobs/123/other').platform, 'other');
});
test('descoberta usa ID da API mesmo com URL externa configurada pela empresa', async () => {
  const jobs = await discoverGreenhouse('example', async target => {
    assert.equal(target, 'https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true');
    return { ok: true, json: async () => ({ jobs: [{ id: 123, title: 'Frontend', absolute_url: 'https://external.invalid/?gh_jid=123' }] }) };
  });
  assert.equal(jobs[0].url, 'https://job-boards.greenhouse.io/example/jobs/123');
  await assert.rejects(discoverGreenhouse('../bad'));
});
test('inspeção consulta campos públicos e confere ID do destino', async () => {
  const data = { id: 123, title: 'Frontend', questions: form.questions, data_compliance: [{ requires_consent: true }] };
  const fetched = await inspectGreenhouse(url, async target => {
    assert.equal(target, 'https://boards-api.greenhouse.io/v1/boards/example/jobs/123?questions=true');
    return { ok: true, json: async () => data };
  });
  assert.equal(fetched.questions.length, 3);
  assert.equal(fetched.sendImplemented, true);
  await assert.rejects(inspectGreenhouse(url, async () => ({ ok: true, json: async () => ({ ...data, id: 999 }) })));
});
test('valida alternativas de currículo, opção zero e campos ausentes', () => {
  const valid = { first_name: 'Teste', resume_text: 'Minha experiência', question_1: 0 };
  assert.equal(validateAnswers(form, valid).valid, true);
  assert.equal(validateAnswers(form, { ...valid, resume_text: '' }, { resume: 'curriculo.pdf' }).valid, true);
  const incomplete = validateAnswers(form, { first_name: 'Teste', question_1: 0 });
  assert.equal(incomplete.valid, false);
  assert.deepEqual(incomplete.missing[0].fields, ['resume', 'resume_text']);
  assert.equal(validateAnswers(form, { ...valid, question_1: 'inventado' }).invalid.length, 1);
});
test('consentimento e respostas demográficas nunca são inventados', () => {
  const consentForm = { ...form, questions: [], dataCompliance: [{ requires_processing_consent: true, requires_retention_consent: true }] };
  assert.equal(validateAnswers(consentForm).missing.length, 2);
  assert.equal(validateAnswers(consentForm, {}, {}, { gdpr_processing_consent_given: true, gdpr_retention_consent_given: true }).valid, true);
  const demographic = { ...form, questions: [], demographicQuestions: { questions: [{ required: true, label: 'Pergunta demográfica' }] } };
  assert.equal(validateAnswers(demographic).unsupported.length, 1);
});
test('Greenhouse sem chave da empresa não envia', async () => {
  const q = prepare({ name: 'Teste', email: 'test@example.invalid' }, [{ url }]);
  Object.assign(q.items[0], { approved: true, requiredFieldsVerified: true });
  await runQueue(q, { send: true, env: {}, fetcher: () => assert.fail('Não enviar') });
  assert.equal(q.items[0].status, 'credential_required');
});

const senderQueue = () => {
  const q = prepare({ name: 'Teste Completo', email: 'test@example.invalid' }, [{ url }]);
  Object.assign(q.items[0], { approved: true, requiredFieldsVerified: true, answers: { first_name: 'Teste', last_name: 'Completo', email: 'test@example.invalid', resume_text: 'Projeto real', question_1: 0 }, consent: {} });
  return q;
};
const sendOptions = { send: true, env: { GREENHOUSE_KEY_EXAMPLE: 'fake-key' }, delay: async () => {} };
const schemaResponse = () => ({ ok: true, status: 200, json: async () => ({ id: 123, title: 'Teste', questions: form.questions }) });

test('Greenhouse consulta esquema antes do POST, mantém identidade e usa Basic Auth', async () => {
  const q = senderQueue(); const methods = []; const states = [];
  const fetcher = async (target, options) => {
    methods.push(options.method || 'GET');
    if (!options.method) return schemaResponse();
    assert.equal(states.at(-1), 'sending');
    assert.equal(target, 'https://boards-api.greenhouse.io/v1/boards/example/jobs/123');
    assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('fake-key:').toString('base64'));
    assert.equal(options.body.get('first_name'), 'Teste');
    assert.equal(options.body.get('last_name'), 'Completo');
    assert.equal(options.body.get('email'), 'test@example.invalid');
    assert.equal(options.body.get('question_1'), '0');
    assert.equal(options.body.has('data_compliance[gdpr_consent_given]'), false);
    assert.equal(options.body.has('undocumented'), false);
    return { ok: true, status: 200, json: async () => ({ message: 'Application submitted successfully' }) };
  };
  q.items[0].answers.undocumented = 'Do not send';
  await runQueue(q, { ...sendOptions, fetcher, persist: value => states.push(value.items[0].status) });
  assert.deepEqual(methods, ['GET', 'POST']);
  assert.equal(q.items[0].status, 'accepted_unverified');
  assert.equal(q.items[0].receipt.httpStatus, 200);
  await runQueue(q, { ...sendOptions, fetcher: () => assert.fail('Não repetir automaticamente') });
  assert(!JSON.stringify(q).includes('fake-key'));
});

test('Greenhouse bloqueia respostas obrigatórias ausentes mesmo com aprovação manual', async () => {
  const q = senderQueue(); delete q.items[0].answers.resume_text;
  await runQueue(q, { ...sendOptions, fetcher: async (_, options) => { assert.equal(options.method, undefined); return schemaResponse(); } });
  assert.equal(q.items[0].status, 'pending_review');
  assert(q.items[0].validation.missing.some(item => item.label === 'Resume'));
  assert.equal(q.items[0].attempts, 0);
});

test('Greenhouse simula apenas GET e timeout após POST não permite repetição', async () => {
  const dry = senderQueue();
  await runQueue(dry, { ...sendOptions, send: false, fetcher: async (_, options) => { assert.equal(options.method, undefined); return schemaResponse(); } });
  assert.equal(dry.items[0].status, 'ready');
  const q = senderQueue();
  await runQueue(q, { ...sendOptions, fetcher: async (_, options) => { if (!options.method) return schemaResponse(); throw new Error('timeout with secret'); } });
  assert.equal(q.items[0].status, 'uncertain');
  await runQueue(q, { ...sendOptions, fetcher: () => assert.fail('Não repetir timeout') });
});

test('Greenhouse falha de inspeção é distinta de tentativa de envio incerta', async () => {
  const q = senderQueue();
  await runQueue(q, { ...sendOptions, fetcher: async () => { throw new Error('offline'); } });
  assert.equal(q.items[0].status, 'preflight_failed');
  assert.equal(q.items[0].attempts, 0);
});

test('Greenhouse nova pergunta obrigatória impede envio antes aprovado', async () => {
  const q = senderQueue();
  await runQueue(q, { ...sendOptions, fetcher: async (_, options) => {
    assert.equal(options.method, undefined);
    return { ok: true, status: 200, json: async () => ({ id: 123, questions: [...form.questions, question('Nova pergunta', true, [field('question_99')])] }) };
  } });
  assert.equal(q.items[0].status, 'pending_review');
  assert.deepEqual(q.items[0].validation.missing[0].fields, ['question_99']);
});
