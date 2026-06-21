// ==================== 请在这里修改 ====================
// 把下面这行改成你自己的 Solana 地址
const solanaAddress = "9yc39BhPViXvXfCd8X2MhswcaPje7x2pTbzX5r2sW7LY";
// =====================================================

const bs58 = require('bs58').default;   // ← 这里改了！加了 .default

// 转换代码
const bytes = bs58.decode(solanaAddress);
const hex = '0x' + Buffer.from(bytes).toString('hex');

console.log("✅ 转换成功！请复制下面这行作为 recipient：");
console.log(hex);
console.log("\n长度应该是 66 个字符（0x 开头 + 64 个字母数字）");