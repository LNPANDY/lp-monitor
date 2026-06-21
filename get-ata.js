const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');

const walletAddress = "HomiRPKNLU42ecES1ghyWHCoix1znnoXuJrJ7H92KGUB";   // ← 你的地址

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

const ata = getAssociatedTokenAddressSync(
  SOL_MINT,
  new PublicKey(walletAddress)
);

console.log("✅ 你的钱包地址 :", walletAddress);
console.log("✅ 正确的 SOL ATA :", ata.toBase58());
console.log("\n把这个 ATA 地址复制下来，用于下次跨链的 recipient");