// 把「現在」往後（或往前）推 N 天——專門用來抓測試與程式裡的日期炸彈（批次 103）。
//
//   SHIFT_DAYS=45 node --import ./tools/time-travel/shift.mjs test/test-flow.mjs
//   SHIFT_DAYS=45 npm test        （test/run-all.mjs 會自己帶上這支）
//
// 緣起：測試資料裡有一場活動寫死 `2026-10-01`，日期一過，「近期場次」的測試就全紅，而且
// 是在沒有人改任何程式的情況下紅的。寫死的日期只要晚個幾天、幾個月，一定會再炸一次，
// 與其等它炸，不如現在就把時間撥快、一次找出所有的。
//
// 只改 `Date.now()` 與無參數的 `new Date()`；帶參數的 `new Date(x)`、Date.parse、Date.UTC
// 都照舊，所以「固定日期」的測試不受影響，只有「依現在時間」的才會動。
const days = Number(process.env.SHIFT_DAYS || 0);
if (days) {
  const OFFSET = days * 86400000;
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + OFFSET);
      else super(...args);
    }
    static now() { return RealDate.now() + OFFSET; }
  }
  globalThis.Date = ShiftedDate;
}
