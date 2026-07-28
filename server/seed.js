/** Seed a few shared quick-reply templates. Safe to run multiple times. */
import { Templates } from './db.js';

const existing = Templates.listFor(null).map((t) => t.title);
const defaults = [
  { title: 'Приветствие', body: 'Здравствуйте! Меня зовут оператор поддержки. Чем могу помочь?' },
  { title: 'Уточнение', body: 'Подскажите, пожалуйста, чуть подробнее — и я сразу помогу.' },
  { title: 'Просьба подождать', body: 'Секунду, уточняю информацию по вашему вопросу 🙏' },
  { title: 'Доставка', body: 'Доставляем по всей стране за 1–3 дня. Оформить заказ можно прямо на сайте.' },
  { title: 'Прощание', body: 'Спасибо за обращение! Хорошего дня 🙂 Будем рады помочь снова.' },
];

let added = 0;
for (const t of defaults) {
  if (!existing.includes(t.title)) { Templates.create({ operatorId: null, ...t }); added++; }
}
console.log(`Seed complete. Added ${added} template(s).`);
process.exit(0);
