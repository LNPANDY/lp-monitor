import { testChannel, channelStatus } from "@/lib/notify";
import { ok, fail, getBody } from "@/lib/api";
import type { ChannelKey } from "@/lib/notify/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return ok(channelStatus());
}

/** body: { channel: 'telegram' | 'bark' | 'serverchan' | 'wecom' } 发送一条测试消息。 */
export async function POST(req: Request) {
  const b = await getBody<{ channel?: ChannelKey }>(req);
  if (!b.channel) return fail("channel 必填");
  const ok_ = await testChannel(b.channel);
  if (!ok_) return fail("发送失败：检查该渠道是否已在 .env.local 配置", 500);
  return ok({ channel: b.channel });
}
