/** Seed demo sites + shared quick-reply templates. Safe to run repeatedly. */
import { Sites, Templates } from './db.js';

/* --- Demo projects: one team handling several brands at once ---------- */
const demoSites = [
  'Casino Royal', 'LuckyStar', 'GoldenBet', 'NeonSpin',
  'JackpotCity', 'RedDice', 'VelvetPlay', 'AceVegas',
];

const existingSites = Sites.list({ includeArchived: true }).map((s) => s.name);
let sitesAdded = 0;
for (const name of demoSites) {
  if (!existingSites.includes(name)) { Sites.create({ name }); sitesAdded++; }
}

/* --- Shared templates ------------------------------------------------- */
const existingTpl = Templates.listFor(null).map((t) => t.title);
const defaults = [
  { title: 'Приветствие', body: 'Здравствуйте! Меня зовут оператор поддержки. Чем могу помочь?' },
  { title: 'Уточнение', body: 'Подскажите, пожалуйста, чуть подробнее — и я сразу помогу.' },
  { title: 'Просьба подождать', body: 'Секунду, уточняю информацию по вашему вопросу 🙏' },
  { title: 'Проверка аккаунта', body: 'Уточните, пожалуйста, логин или email вашего аккаунта — проверю статус.' },
  { title: 'Прощание', body: 'Спасибо за обращение! Хорошего дня 🙂 Будем рады помочь снова.' },
];
let tplAdded = 0;
for (const t of defaults) {
  if (!existingTpl.includes(t.title)) { Templates.create({ operatorId: null, ...t }); tplAdded++; }
}

console.log(`Seed complete. Added ${sitesAdded} site(s), ${tplAdded} template(s).`);
console.log('Sites:');
for (const s of Sites.list()) console.log(`  ${s.name.padEnd(14)} ${s.key}`);
process.exit(0);
