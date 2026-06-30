import { ok, fail, getBody } from "@/lib/api";
import { runScanMethodComparison, printComparisonResult } from "@/lib/scan-method-test";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const walletAddress = url.searchParams.get("wallet_address");
  const chainId = url.searchParams.get("chain_id");
  
  try {
    const { transferScan, contractDirect } = await runScanMethodComparison(
      walletAddress || undefined,
      chainId ? parseInt(chainId) : undefined
    );
    
    const result = {
      transferScan,
      contractDirect,
      comparison: {
        speedup: transferScan.timeMs / contractDirect.timeMs,
        improvement: ((transferScan.timeMs - contractDirect.timeMs) / transferScan.timeMs * 100).toFixed(1),
        positionsMatch: transferScan.positions === contractDirect.positions,
        winner: transferScan.timeMs < contractDirect.timeMs ? "transfer_scan" : "contract_direct"
      }
    };
    
    return ok(result);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "测试失败");
  }
}

// 测试CLI入口
export async function POST(req: Request) {
  const b = await getBody<{ wallet_address?: string; chain_id?: number }>(req);
  
  try {
    const { transferScan, contractDirect } = await runScanMethodComparison(
      b.wallet_address,
      b.chain_id
    );
    
    // 在服务端打印结果到日志
    printComparisonResult(transferScan, contractDirect);
    
    return ok({
      transferScan,
      contractDirect,
      comparison: {
        speedup: transferScan.timeMs / contractDirect.timeMs,
        improvement: ((transferScan.timeMs - contractDirect.timeMs) / transferScan.timeMs * 100).toFixed(1),
        positionsMatch: transferScan.positions === contractDirect.positions,
        winner: transferScan.timeMs < contractDirect.timeMs ? "transfer_scan" : "contract_direct"
      }
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "测试失败");
  }
}