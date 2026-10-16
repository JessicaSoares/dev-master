const { identify } = require('./engine.cjs');
const base = 'https://boards-api.greenhouse.io/v1/boards';
const tokenPattern = /^[a-z0-9_-]+$/i;
const fs = require('node:fs');
const path = require('node:path');

async function readJson(url, fetcher) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Consulta Greenhouse retornou HTTP ${response.status}.`);
  return response.json();
}

async function discoverGreenhouse(company, fetcher = fetch) {
  if (!tokenPattern.test(company)) throw new Error('Identificador de empresa inválido.');
  const data = await readJson(`${base}/${company}/jobs?content=true`, fetcher);
  if (!Array.isArray(data.jobs)) throw new Error('Resposta de vagas inválida.');
  return data.jobs.map(job => {
    if (!Number.isSafeInteger(job.id) || job.id <= 0 || typeof job.title !== 'string') throw new Error('Vaga inválida na resposta.');
    // Companies can configure an external absolute_url. Keep the canonical hosted form for routing.
    return { title: job.title, company, url: `https://job-boards.greenhouse.io/${company}/jobs/${job.id}`, description: job.content || '', descriptionFormat: 'html-encoded', location: job.location?.name || '', tags: [] };
  });
}

async function inspectGreenhouse(raw, fetcher = fetch) {
  const target = identify(raw);
  if (target.platform !== 'greenhouse') throw new Error('Esta URL não é de uma vaga Greenhouse reconhecida.');
  const data = await readJson(`${base}/${target.company}/jobs/${target.posting}?questions=true`, fetcher);
  if (String(data.id) !== target.posting || !Array.isArray(data.questions)) throw new Error('Formulário ausente ou destino diferente.');
  const groups = ['questions', 'location_questions', 'compliance'];
  const questions = groups.flatMap(group => (data[group] || []).map(question => ({
    group, label: question.label, required: question.required === true,
    fields: (question.fields || []).map(field => ({ name: field.name, type: field.type, values: field.values || [] })),
  })));
  return {
    platform: 'greenhouse', target, title: data.title, fetchedAt: new Date().toISOString(),
    questions, dataCompliance: data.data_compliance || [], demographicQuestions: data.demographic_questions || null,
    aiDisclaimer: data.ai_disclaimer || null,
    sendImplemented: true,
  };
}

function validateAnswers(form, answers = {}, files = {}, consent = {}) {
  const missing = []; const invalid = [];
  const types = ['input_text', 'textarea', 'input_hidden', 'input_file', 'multi_value_single_select', 'multi_value_multi_select'];
  const filled = value => value !== undefined && value !== null && (Array.isArray(value) ? value.length > 0 : String(value).trim().length > 0);
  for (const question of form.questions) {
    let answered = false;
    for (const field of question.fields) {
      const value = field.type === 'input_file' ? files[field.name] : answers[field.name];
      if (!filled(value)) continue;
      if (Array.isArray(value) ? value.some(v => !['string', 'number', 'boolean'].includes(typeof v)) : !['string', 'number', 'boolean'].includes(typeof value)) { invalid.push({ field: field.name, reason: 'Resposta deve ser texto, número ou opção válida.' }); continue; }
      if (!types.includes(field.type)) { invalid.push({ field: field.name, reason: 'Tipo de campo não suportado.' }); continue; }
      if (Array.isArray(value) && field.type !== 'multi_value_multi_select') { invalid.push({ field: field.name, reason: 'Este campo não aceita múltiplas respostas.' }); continue; }
      if (field.type === 'multi_value_single_select' || field.type === 'multi_value_multi_select') {
        const selected = Array.isArray(value) ? value : [value];
        if ((field.type === 'multi_value_single_select' && selected.length !== 1) || selected.some(v => !field.values.some(option => String(option.value) === String(v)))) {
          invalid.push({ field: field.name, reason: 'Opção não pertence ao formulário.' }); continue;
        }
      }
      answered = true;
    }
    // A question can have alternative fields: resume upload OR resume text.
    if (question.required && !answered) missing.push({ label: question.label, fields: question.fields.map(f => f.name) });
  }
  for (const policy of form.dataCompliance) {
    if (policy.requires_processing_consent && consent.gdpr_processing_consent_given !== true) missing.push({ label: 'Consentimento explícito para processamento de dados', fields: ['gdpr_processing_consent_given'] });
    if (policy.requires_retention_consent && consent.gdpr_retention_consent_given !== true) missing.push({ label: 'Consentimento explícito para retenção de dados', fields: ['gdpr_retention_consent_given'] });
    if (policy.requires_consent && !policy.requires_processing_consent && !policy.requires_retention_consent && consent.gdpr_consent_given !== true) missing.push({ label: 'Consentimento explícito para dados pessoais', fields: ['gdpr_consent_given'] });
  }
  const unsupported = (form.demographicQuestions?.questions || []).filter(q => q.required).map(q => ({ label: q.label, reason: 'Responder no formulário original; campo demográfico não implementado.' }));
  return { valid: missing.length === 0 && invalid.length === 0 && unsupported.length === 0, missing, invalid, unsupported, sendsApplication: false, note: 'A validação não verifica os arquivos no disco nem autoriza envio. Revise a política da vaga e suas respostas.' };
}
async function buildGreenhouseRequest(item, target, key, fetcher = fetch) {
  const form = await inspectGreenhouse(target.canonical, fetcher);
  const answers = item.answers || {};
  const files = { ...(item.files || {}) };
  if (item.resumePath && !files.resume) files.resume = item.resumePath;
  const consent = item.consent || {};
  const validation = validateAnswers(form, answers, files, consent);
  // These are the documented base identity fields, regardless of form customization.
  for (const name of ['first_name', 'last_name', 'email']) {
    if (typeof answers[name] !== 'string' || !answers[name].trim()) validation.missing.push({ label: name, fields: [name] });
  }
  if (answers.email !== item.candidate.email) validation.invalid.push({ field: 'email', reason: 'E-mail diferente do perfil aprovado.' });
  if (validation.missing.length || validation.invalid.length || validation.unsupported.length) return { validation, blocked: true };
  const body = new FormData();
  const fields = new Map(form.questions.flatMap(q => q.fields.map(f => [f.name, f])));
  for (const name of ['first_name', 'last_name', 'email']) body.set(name, answers[name]);
  for (const [name, field] of fields) {
    if (field.type === 'input_file') {
      if (!files[name]) continue;
      const file = files[name];
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Use caminho absoluto para anexos.');
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('Anexo inválido ou maior que 10 MB.');
      body.set(name, new Blob([fs.readFileSync(file)]), path.basename(file));
    } else if (answers[name] !== undefined && answers[name] !== null && String(answers[name]).trim()) {
      const value = answers[name];
      if (field.type === 'multi_value_multi_select') for (const selected of (Array.isArray(value) ? value : [value])) body.append(name.endsWith('[]') ? name : name + '[]', String(selected));
      else body.set(name, String(value));
    }
  }
  // Only explicit decisions for policies shown by this job may be transmitted.
  const consentNames = new Set();
  for (const policy of form.dataCompliance) {
    if (policy.requires_processing_consent) consentNames.add('gdpr_processing_consent_given');
    if (policy.requires_retention_consent) consentNames.add('gdpr_retention_consent_given');
    if (policy.requires_consent && !policy.requires_processing_consent && !policy.requires_retention_consent) consentNames.add('gdpr_consent_given');
  }
  for (const name of consentNames) if (consent[name] === true) body.set(`data_compliance[${name}]`, '1');
  return { url: `${base}/${target.company}/jobs/${target.posting}`, body, headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64') }, formFetchedAt: form.fetchedAt };
}
module.exports = { discoverGreenhouse, inspectGreenhouse, validateAnswers, buildGreenhouseRequest };
