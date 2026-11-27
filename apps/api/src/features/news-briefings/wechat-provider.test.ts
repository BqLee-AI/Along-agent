import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createWechatProvider, sealWechatBinding } from './wechat-provider.js';

const defaultOrigin = 'https://ilinkai.weixin.qq.com';
const regionOrigin = 'https://ilinkai-hk.weixin.qq.com';
const token = 'test-provider-token';

function simulate(...replies: (Response | Error)[]) {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const fetcher = async (input: string | URL, init?: RequestInit) => {
    requests.push({ url: new URL(String(input)), init });
    const response = replies.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error('Unexpected iLink call');
    return response;
  };
  return { provider: createWechatProvider(fetcher), requests };
}

void test('iLink self binding follows a Tencent region redirect and submits the phone PIN only on demand', async () => {
  const { provider, requests } = simulate(
    Response.json({ qrcode: 'opaque+qr', qrcode_img_content: 'https://weixin.qq.com/example' }),
    Response.json({ status: 'scaned_but_redirect', redirect_host: 'ilinkai-hk.weixin.qq.com' }),
    Response.json({ status: 'confirmed_but_need_verifycode' }),
    Response.json({
      status: 'confirmed',
      bot_token: token,
      ilink_bot_id: 'bot',
      ilink_user_id: 'recipient',
    }),
    new Response(null, { status: 204 }),
    Response.json({
      get_updates_buf: 'next-cursor',
      msgs: [
        {
          from_user_id: 'another-recipient',
          message_type: 1,
          context_token: 'foreign',
          item_list: [{ type: 1, text_item: { text: '绑定' } }],
        },
        {
          from_user_id: 'recipient',
          message_type: 1,
          context_token: 'unrelated',
          item_list: [{ type: 1, text_item: { text: '你好' } }],
        },
      ],
    }),
    Response.json({
      msgs: [
        {
          from_user_id: 'recipient',
          message_type: 1,
          context_token: 'activated',
          item_list: [{ type: 1, text_item: { text: '绑定' } }],
        },
      ],
    }),
  );
  const begun = await provider.begin();
  assert.match(begun.qrDataUrl, /^data:image\/png;base64,/);
  const scanned = await provider.poll(begun.pairing);
  assert.equal(scanned.status, 'scanned');
  assert.ok('pairing' in scanned);
  const pinRequired = await provider.poll(scanned.pairing);
  assert.equal(pinRequired.status, 'pin_required');
  assert.ok('pairing' in pinRequired);
  const activation = await provider.poll(pinRequired.pairing, '0073');
  assert.equal(activation.status, 'activation_required');
  assert.ok('pairing' in activation);
  const waiting = await provider.poll(activation.pairing);
  assert.equal(waiting.status, 'activation_required');
  assert.ok('pairing' in waiting);
  assert.deepEqual(await provider.poll(waiting.pairing), {
    status: 'bound',
    credential: {
      origin: regionOrigin,
      token,
      botId: 'bot',
      recipient: 'recipient',
      contextToken: 'activated',
    },
  });
  assert.equal(requests[0]?.url.href, `${defaultOrigin}/ilink/bot/get_bot_qrcode?bot_type=3`);
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { local_token_list: [] });
  assert.equal(requests[1]?.url.origin, defaultOrigin);
  assert.equal(requests[2]?.url.origin, regionOrigin);
  assert.equal(requests[2]?.url.searchParams.get('qrcode'), 'opaque+qr');
  assert.equal(requests[2]?.url.searchParams.has('verify_code'), false);
  assert.equal(requests[3]?.url.searchParams.get('verify_code'), '0073');
  assert.equal(new Headers(requests[3]?.init?.headers).get('Authorization'), null);
  assert.equal(requests[4]?.url.href, `${regionOrigin}/ilink/bot/msg/notifystart`);
  assert.equal(requests[6]?.url.href, `${regionOrigin}/ilink/bot/getupdates`);
  assert.equal(JSON.parse(String(requests[6]?.init?.body)).get_updates_buf, 'next-cursor');
});

void test('iLink will not send a QR secret to a host outside WeChat', async () => {
  const { provider, requests } = simulate(
    Response.json({ status: 'scaned_but_redirect', redirect_host: 'weixin.qq.com.example.org' }),
    Response.json({ status: 'expired' }),
  );
  const pairing = { qrcode: 'opaque', origin: defaultOrigin, status: 'waiting' } as const;
  const first = await provider.poll(pairing);
  assert.ok('pairing' in first);
  assert.deepEqual(await provider.poll(first.pairing), { status: 'expired' });
  assert.equal(requests[1]?.url.origin, defaultOrigin);
  assert.equal(requests[1]?.init?.redirect, 'error');
});

void test('iLink sends only to the bound recipient and distinguishes success, rejection and ambiguity', async () => {
  const previous = process.env.MODEL_PROVIDER_ENCRYPTION_KEY;
  process.env.MODEL_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    const { provider, requests } = simulate(
      Response.json({ ret: 0 }),
      Response.json({ message_id: '18446744073709551615' }),
      Response.json({ message_id: 123456 }),
      Response.json({ message_id: '0' }),
      Response.json({ ret: 0, errcode: -14 }),
      Response.json({}),
      new Response(null, { status: 502 }),
      new Error('connection closed'),
    );
    const credential = {
      origin: defaultOrigin,
      token,
      botId: 'test-bot',
      recipient: 'recipient',
      contextToken: 'activated',
    };
    const ciphertext = sealWechatBinding('owner', 'binding', credential);
    for (const [owner, id, recipient] of [
      ['other', 'binding', 'recipient'],
      ['owner', 'old', 'recipient'],
      ['owner', 'binding', 'other'],
    ] as const) {
      assert.deepEqual(await provider.send(ciphertext, owner, id, recipient, 'News'), {
        status: 'failed',
      });
    }
    const untrusted = sealWechatBinding('owner', 'binding', {
      ...credential,
      origin: 'https://weixin.qq.com.example.org',
    });
    assert.deepEqual(await provider.send(untrusted, 'owner', 'binding', 'recipient', 'News'), {
      status: 'failed',
    });
    assert.equal(requests.length, 0);
    for (const status of [
      'accepted',
      'accepted',
      'accepted',
      'unknown',
      'failed',
      'unknown',
      'unknown',
      'unknown',
    ]) {
      assert.deepEqual(await provider.send(ciphertext, 'owner', 'binding', 'recipient', 'News'), {
        status,
      });
    }
    assert.equal(requests[0]?.url.href, `${defaultOrigin}/ilink/bot/sendmessage`);
    assert.equal(requests[0]?.init?.redirect, 'error');
    assert.equal(new Headers(requests[0]?.init?.headers).get('Authorization'), `Bearer ${token}`);
    const { msg } = JSON.parse(String(requests[0]?.init?.body));
    assert.equal(msg.to_user_id, 'recipient');
    assert.deepEqual(msg.item_list, [{ type: 1, text_item: { text: 'News' } }]);
  } finally {
    if (previous === undefined) delete process.env.MODEL_PROVIDER_ENCRYPTION_KEY;
    else process.env.MODEL_PROVIDER_ENCRYPTION_KEY = previous;
  }
});
