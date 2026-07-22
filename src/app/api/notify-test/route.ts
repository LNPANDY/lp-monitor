import { testChannel, channelStatus, getPushSourceTag } from "@/lib/notify";
import { ok, fail, getBody } from "@/lib/api";
import type { ChannelKey } from "@/lib/notify/types";

export const dynamic = "force-dynamic";

export async function GET() {
  // channelStatus() 返回数组，保持原结构不变（前端 config 页 useSWR<any[]> 依赖数组）
  // source 通过自定义 response header 附加，前端如需可读
  const res = ok(channelStatus());
  res.headers.set("X-Push-Source", getPushSourceTag());
  return res;
}

/** body: { channel: 'telegram' | 'bark' | 'serverchan' | 'wecom' } 发送一条测试消息。 */
export async function POST(req: Request) {
  const b = await getBody<{ channel?: ChannelKey }>(req);
  if (!b.channel) return fail("channel 必填");
  const ok_ = await testChannel(b.channel);
  if (!ok_) return fail("发送失败：检查该渠道是否已在 .env.local 配置", 500);
  return ok({ channel: b.channel });
}
