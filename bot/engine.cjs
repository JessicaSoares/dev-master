const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { identifyCandidateSite } = require('./candidate-sites.cjs');

function identify(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use uma URL HTTPS sem credenciais.');
  const parts = url.pathname.split('/').filter(Boolean);
  const host = url.hostname.toLowerCase();
  const candidateSite = identifyCandidateSite(url);
  if (candidateSite) return candidateSite;
  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(host) && parts.length >= 2 && /^[a-z0-9_-]+$/i.test(parts[0]) && /^[a-f0-9-]{36}$/i.test(parts[1])) {
    const region = host === 'jobs.eu.lever.co' ? 'eu' : 'global';
    return { platform: 'lever', company: parts[0], posting: parts[1], region, canonical: `https://${host}/${parts[0]}/${parts[1]}`, capability: 'credential_required' };
  }
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return { platform: 'linkedin', canonical: url.origin + url.pathname, capability: 'manual', reason: 'A plataforma restringe automação de atividades.' };
  if (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(host) && parts.length === 3 && /^[a-z0-9_-]+$/i.test(parts[0]) && parts[1] === 'jobs' && /^\d+$/.test(parts[2])) return { platform: 'greenhouse', company: parts[0], posting: parts[2], canonical: `https://job-boards.greenhouse.io/${parts[0]}/jobs/${parts[2]}`, capability: 'credential_required', reason: 'Envio condicionado à credencial da empresa e validação do formulário.' };
  return { platform: 'other', canonical: url.origin + url.pathname + url.search, capability: 'not_implemented', reason: 'Site ainda sem conector. Concluir pelo formulário original.' };
}

function prepare(profile, jobs) {
  if (!profile?.name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email || '')) throw new Error('Preencha nome e e-mail válido no perfil.');
  const unique = new Map();
  for (const job of jobs) {
    try {
      const target = identify(job.url);
      const identity = target.identity || target.canonical;
      if (unique.has(identity)) continue;
      unique.set(identity, {
        id: crypto.createHash('sha256').update(profile.email.toLowerCase().trim() + '\n' + identity).digest('hex'),
        title: job.title || '', target, status: 'pending_review', approved: false,
        requiredFieldsVerified: false, attempts: 0,
        candidate: { name: profile.name.trim(), email: profile.email.trim(), comments: [profile.about, profile.projects].filter(Boolean).join('\n\n'), urls: profile.github ? { GitHub: profile.github } : {} },
        resumePath: null,
        ...(target.platform === 'greenhouse' ? { answers: { email: profile.email.trim() }, files: {}, consent: {} } : {}),
      });
    } catch (error) {
      const id = crypto.randomUUID();
      unique.set(id, { id, title: job.title || '', status: 'invalid', reason: error.message, approved: false });
    }
  }
  return { schemaVersion: 1, createdAt: new Date().toISOString(), items: [...unique.values()] };
}

async function discoverLever(company, region = 'global', fetcher = fetch) {
  if (!/^[a-z0-9_-]+$/i.test(company)) throw new Error('Identificador de empresa inválido.');
  if (!['global', 'eu'].includes(region)) throw new Error('Região inválida.');
  const base = region === 'eu' ? 'https://api.eu.lever.co' : 'https://api.lever.co';
  const result = [];
  for (let skip = 0; skip < 10000; skip += 100) {
    const response = await fetcher(`${base}/v0/postings/${company}?mode=json&limit=100&skip=${skip}`, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Consulta de vagas retornou HTTP ${response.status}.`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Resposta de vagas inválida.');
    for (const job of page) {
      const target = identify(job.hostedUrl);
      if (target.platform !== 'lever' || target.company !== company || target.region !== region) throw new Error('A API retornou uma vaga de origem inesperada.');
      result.push({ title: job.text, company, url: target.canonical, description: job.descriptionPlain || '', location: job.categories?.location || '', mode: job.workplaceType || '', tags: [] });
    }
    if (page.length < 100) return result;
  }
  throw new Error('Limite de paginação atingido; refine a fonte antes de continuar.');
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

async function runQueue(queue, { send = false, env = process.env, fetcher = fetch, persist = () => {}, now = () => Date.now(), delay = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (const item of queue.items) {
    // Never retry uncertain or already accepted submissions automatically.
    if (['submitted', 'accepted_unverified', 'uncertain', 'sending', 'invalid', 'failed'].includes(item.status)) continue;
    if (item.approved !== true || item.requiredFieldsVerified !== true) { item.status = 'pending_review'; persist(queue); continue; }
    if (!['lever', 'greenhouse'].includes(item.target?.platform)) { item.status = 'manual_required'; persist(queue); continue; }
    const keyName = item.target.platform.toUpperCase() + '_KEY_' + item.target.company.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const key = env[keyName];
    if (!key) { item.status = 'credential_required'; item.reason = `Configure ${keyName} com uma chave autorizada pela empresa.`; persist(queue); continue; }
    if (item.retryAt && Date.parse(item.retryAt) > now()) continue;
    let target;
    try {
      target = identify(item.target.canonical);
      if (target.platform !== item.target.platform || target.company !== item.target.company || target.posting !== item.target.posting || target.region !== item.target.region) throw new Error('Destino alterado.');
      if (!item.candidate?.name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.candidate.email || '')) throw new Error('Dados da candidata inválidos.');
    } catch { item.status = 'invalid'; item.reason = 'Revise o destino e os dados da candidata.'; persist(queue); continue; }
    let request;
    if (target.platform === 'greenhouse') {
      try {
        request = await require('./greenhouse.cjs').buildGreenhouseRequest(item, target, key, fetcher);
        if (request.blocked) { item.status = 'pending_review'; item.validation = request.validation; persist(queue); continue; }
        delete item.validation;
      } catch { item.status = 'preflight_failed'; item.reason = 'Não foi possível validar o formulário atual ou seus anexos. Nenhum POST realizado.'; persist(queue); continue; }
    } else {
    const body = new FormData();
    body.set('name', item.candidate.name); body.set('email', item.candidate.email);
    body.set('comments', item.candidate.comments || '');
    for (const [label, value] of Object.entries(item.candidate.urls || {})) body.set(`urls[${label}]`, value);
    if (item.resumePath) {
      try {
        const stat = fs.statSync(item.resumePath);
        if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('Arquivo inválido.');
        body.set('resume', new Blob([fs.readFileSync(item.resumePath)]), path.basename(item.resumePath));
      } catch { item.status = 'invalid'; item.reason = 'Currículo ausente, ilegível ou maior que 10 MB.'; persist(queue); continue; }
    }
    const base = target.region === 'eu' ? 'https://api.eu.lever.co' : 'https://api.lever.co';
    request = { url: `${base}/v0/postings/${target.company}/${target.posting}?key=${encodeURIComponent(key)}`, body };
    }
    if (!send) { item.status = 'ready'; persist(queue); continue; }
    item.status = 'sending'; item.attempts += 1; item.lastAttemptAt = new Date(now()).toISOString();
    persist(queue); // Persist before network activity; an interrupted send requires manual verification.
    let response;
    try {
      response = await fetcher(request.url, { method: 'POST', body: request.body, headers: request.headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
      const result = await response.json();
      if (target.platform === 'greenhouse' && response.ok && result && result.error === undefined && result.errors === undefined && result.success !== false) {
        item.status = 'accepted_unverified'; item.receipt = { httpStatus: response.status, at: new Date(now()).toISOString(), formFetchedAt: request.formFetchedAt };
        item.reason = 'API respondeu HTTP de sucesso, sem contrato de comprovante validado. Confira a candidatura no canal original antes de repetir.';
      } else if (target.platform === 'lever' && response.ok && result.ok === true && typeof result.applicationId === 'string' && result.applicationId.length) {
        item.status = 'submitted'; item.receipt = { applicationId: result.applicationId, at: new Date(now()).toISOString() }; delete item.reason;
      } else if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const seconds = /^\d+$/.test(retry || '') ? Number(retry) : (Date.parse(retry) - now()) / 1000;
        item.status = 'rate_limited'; item.retryAt = new Date(now() + Math.max(60, Number.isFinite(seconds) ? seconds : 60) * 1000).toISOString();
      } else if (response.status >= 400 && response.status < 500) {
        item.status = 'failed'; item.reason = `Envio rejeitado: HTTP ${response.status}. Revise no formulário original.`;
      } else {
        item.status = 'uncertain'; item.reason = 'Sem comprovante de envio. Verifique antes de repetir.';
      }
    } catch {
      // Do not log request errors: their text can include credentials or applicant data.
      if (response?.status === 429) { item.status = 'rate_limited'; item.retryAt = new Date(now() + 60000).toISOString(); }
      else { item.status = 'uncertain'; item.reason = 'Falha de comunicação ou resposta inválida. Verifique antes de repetir.'; }
    }
    persist(queue);
    await delay(1000);
  }
  return queue;
}
module.exports = { identify, prepare, discoverLever, runQueue, writeAtomic };
