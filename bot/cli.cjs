const fs = require('node:fs');
const path = require('node:path');
const { prepare, discoverLever, runQueue, writeAtomic } = require('./engine.cjs');
const { discoverGreenhouse, inspectGreenhouse, validateAnswers } = require('./greenhouse.cjs');
const { buildHandoff, policies } = require('./candidate-sites.cjs');
async function main() {
  const [command, input, output, ...flags] = process.argv.slice(2);
  if (command === 'platforms') { console.log(JSON.stringify(policies, null, 2)); return; }
  if (command === 'handoff') {
    if (!input || !output || fs.existsSync(output)) throw new Error('Uso: handoff fila.json arquivo-novo.md');
    const queue = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
    if (queue.schemaVersion !== 1 || !Array.isArray(queue.items)) throw new Error('Fila inválida.');
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, buildHandoff(queue), { flag: 'wx', mode: 0o600 });
    console.log('Material de candidatura preparado localmente. Nenhum envio.'); return;
  }
  if (command === 'inspect') {
    if (!input || !output) throw new Error('Uso: inspect URL arquivo-formulario.json');
    const form = await inspectGreenhouse(input);
    writeAtomic(output, form);
    console.log(`${form.questions.length} perguntas consultadas. Nenhum envio.`); return;
  }
  if (command === 'validate') {
    if (!input || !output) throw new Error('Uso: validate formulario.json respostas.json');
    const form = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
    const data = JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, ''));
    const result = validateAnswers(form, data.answers, data.files, data.consent);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 2;
    return;
  }
  if (command === 'discover') {
    if (!input || !output) throw new Error('Uso: node bot/cli.cjs discover empresa arquivo.json [--eu]');
    const jobs = flags.includes('--greenhouse') ? await discoverGreenhouse(input) : await discoverLever(input, flags.includes('--eu') ? 'eu' : 'global');
    writeAtomic(output, { jobs }); console.log(`${jobs.length} vagas consultadas. Nenhuma candidatura enviada.`); return;
  }
  if (command === 'prepare') {
    if (!input || !output || path.resolve(input) === path.resolve(output)) throw new Error('Uso: node bot/cli.cjs prepare backup.json fila-nova.json');
    if (fs.existsSync(output)) throw new Error('A fila já existe. Preserve o histórico; use outro arquivo.');
    const data = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
    const jobFlag = flags.indexOf('--jobs');
    const jobs = jobFlag >= 0 ? JSON.parse(fs.readFileSync(flags[jobFlag + 1], 'utf8').replace(/^\uFEFF/, '')).jobs : data.jobs;
    const queue = prepare(data.profile, jobs);
    writeAtomic(output, queue); console.log(`${queue.items.length} itens preparados para revisão. Nenhum envio.`); return;
  }
  if (command === 'run') {
    if (!input || (output && output !== '--send')) throw new Error('Uso: node bot/cli.cjs run fila.json [--send]');
    const lock = input + '.lock';
    let fd;
    try { fd = fs.openSync(lock, 'wx'); } catch { throw new Error('Fila bloqueada. Verifique se há outro processo ativo antes de remover o arquivo .lock.'); }
    try {
      const queue = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
      if (queue.schemaVersion !== 1 || !Array.isArray(queue.items)) throw new Error('Formato de fila inválido.');
      await runQueue(queue, { send: output === '--send', persist: q => writeAtomic(input, q) });
      const counts = queue.items.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {});
      console.log(JSON.stringify({ mode: output === '--send' ? 'send' : 'dry-run', counts }, null, 2));
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    return;
  }
  console.log('Dev Master Bot\n  platforms\n  discover empresa saida.json [--eu | --greenhouse]\n  inspect URL formulario.json\n  validate formulario.json respostas.json\n  prepare backup.json fila.json [--jobs vagas.json]\n  handoff fila.json arquivo-novo.md\n  run fila.json [--send]\nPor padrão, não envia candidaturas. Leia bot/README.md.');
}
main().catch(() => { console.error('Operação não concluída. Verifique os argumentos, arquivos, perfil, conexão e bloqueio da fila. Nenhum envio deve ser presumido; consulte os estados da fila.'); process.exitCode = 1; });
