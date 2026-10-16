const policies = {
  indeed: { name: 'Indeed', capability: 'assisted', automaticSubmission: false, reason: 'Indeed proíbe automação externa de candidaturas fora de suas ferramentas oficiais ou autorização escrita.', source: 'https://www.indeed.com/legal?hl=en_US' },
  infojobs: { name: 'InfoJobs', capability: 'assisted', automaticSubmission: false, reason: 'Canal de envio automatizado para candidatas ainda não verificado. Preparação local; conclusão no site.', source: 'https://www.infojobs.com.br/legal/aviso-legal-para-candidatos__15727.aspx' },
  gupy: { name: 'Gupy', capability: 'assisted', automaticSubmission: false, reason: 'A API documentada atende integrações de empresas. Canal de envio para candidatas ainda não verificado.', source: 'https://www.gupy.io/termos-de-uso-recrutamento-e-selecao-candidatos' },
};

function identifyCandidateSite(url) {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let target;
  if (['indeed.com', 'www.indeed.com', 'br.indeed.com'].includes(host)) {
    const jk = url.searchParams.get('jk') || url.searchParams.get('vjk');
    if (jk && /^[a-z0-9]{8,64}$/i.test(jk)) target = { platform: 'indeed', posting: jk, canonical: 'https://br.indeed.com/viewjob?jk=' + encodeURIComponent(jk), identity: 'indeed:' + jk };
    else target = { platform: 'indeed', canonical: url.origin + url.pathname + url.search, needsJobLink: true };
  } else if (['infojobs.com.br', 'www.infojobs.com.br'].includes(host)) {
    const match = url.pathname.match(/__(\d+)\.aspx$/i);
    target = { platform: 'infojobs', canonical: 'https://www.infojobs.com.br' + url.pathname, ...(match ? { posting: match[1], identity: 'infojobs:' + match[1] } : { needsJobLink: true }) };
  } else if (host === 'gupy.io' || host.endsWith('.gupy.io')) {
    const match = url.pathname.match(/^\/jobs\/(\d+)\/?$/);
    // Public company job pages; login and the vacancy portal are not individual jobs.
    if (match && host !== 'gupy.io' && !['login.gupy.io', 'portal.gupy.io'].includes(host)) {
      target = { platform: 'gupy', company: host.slice(0, -'.gupy.io'.length), posting: match[1], canonical: `https://${host}/jobs/${match[1]}`, identity: `gupy:${host}:${match[1]}` };
    } else target = { platform: 'gupy', canonical: url.origin + url.pathname + url.search, needsJobLink: true };
  }
  if (!target) return null;
  return { ...target, ...policies[target.platform], checkedAt: '2026-10-14' };
}

function buildHandoff(queue) {
  const lines = ['# Dev Master — candidaturas para concluir nos sites', '', 'Este arquivo prepara dados localmente. Não é comprovante de envio e não envia candidaturas.', 'Revise as informações e conclua cada candidatura no site original. Não preencha testes, consentimentos ou respostas pessoais com informações inventadas.', ''];
  const text = value => String(value || '').replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '');
  for (const item of queue.items) {
    if (!item.target || !policies[item.target.platform] || ['submitted', 'accepted_unverified'].includes(item.status)) continue;
    lines.push(`## ${text(item.title || 'Vaga sem título')} · ${policies[item.target.platform].name}`, '', `ID: ${item.id}`, '', `Link: ${item.target.canonical}`, '', `Estado: ${item.status} — envio não confirmado`, '', `Observação: ${item.target.reason}`, '');
    if (item.target.needsJobLink) { lines.push('Este link não identifica uma vaga individual. Troque pelo link da vaga antes de se candidatar.', ''); continue; }
    lines.push('### Dados para revisar e copiar', '', `Nome: ${text(item.candidate?.name)}`, `E-mail: ${text(item.candidate?.email)}`, '');
    for (const [label, value] of Object.entries(item.candidate?.urls || {})) lines.push(`${text(label)}: ${text(value)}`, '');
    lines.push('### Resumo e projetos informados por você', '', item.candidate?.comments || 'Preencha resumo e projetos no perfil antes de candidatar.', '', '### Antes de concluir', '', '- Confira empresa, cargo e requisitos da vaga.', '- Confira seu currículo e anexe a versão correta quando solicitado.', '- Responda perguntas obrigatórias com suas informações reais.', '- Leia e decida os consentimentos no próprio site.', '- Após enviar, guarde a confirmação e atualize o acompanhamento no Dev Master.', '');
  }
  return lines.join('\n');
}
module.exports = { policies, identifyCandidateSite, buildHandoff };
