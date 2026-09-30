// 批次 101：看完活動清單後點名清單上的場次（「院士」）要接得住
import assert from 'node:assert/strict';
import { matchShownEvents } from '../lib/router.js';

const day = n => new Date(Date.now() + n * 86400000);
const cards = [
  { id: 'a', name: '工研院院士授證典禮', status: 'active', date: day(7), has_kb: true },
  { id: 'b', name: '2026晶鏈高峰論壇', status: 'active', date: day(2), has_kb: true },
  { id: 'c', name: '院士研討會（未發布）', status: 'draft', date: day(9), has_kb: true },
  { id: 'd', name: '院士座談（沒資料）', status: 'active', date: day(8), has_kb: false },
  { id: 'e', name: '去年的院士論壇', status: 'active', date: day(-400), has_kb: true }
];
assert.deepEqual(matchShownEvents(cards, '院士').map(c => c.id), ['a']);
assert.deepEqual(matchShownEvents(cards, '晶鏈').map(c => c.id), ['b']);
assert.deepEqual(matchShownEvents(cards, '半導體'), []);
assert.deepEqual(matchShownEvents(cards, '院'), []);
console.log('batch101 OK');
