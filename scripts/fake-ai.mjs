// 本地假模型服务：只用于验收界面与 IPC 链路，不产生任何真实模型费用。
// 协议与 OpenAI 兼容 /chat/completions 对齐；按 system 提示词分派四种回答。
import http from 'node:http'

const port = Number(process.argv[2] ?? 8799)

const PLAN = {
  title: '一次函数与图像',
  subject: '数学',
  overview: '这份讲义从一次函数的定义讲到图像与斜率，重点是 k 与 b 如何决定直线的位置。',
  opening: '我们先用一条直线把一次函数接住，再逐句抠它的条件。',
  units: [
    {
      title: '一次函数长什么样',
      source: '第 1 页',
      minutes: 6,
      keyPoints: ['形如 y = kx + b', 'k 不能为 0'],
      segments: [
        {
          source: '形如 y = kx + b（k 不等于 0）的函数叫一次函数。',
          explain: '先把这句话拆开看：它规定了两件事，一是形状必须是 kx 加 b，二是 k 不能是 0。为什么非要管 k？因为 k 一旦是 0，x 就消失了，式子退化成 y 等于 b，图像是一条水平线，不再有“一次”的变化。你可以把它想成走路：k 是每走一步上升多少，b 是出发时站的高度。',
          check: '如果 k 等于 0，图像会变成什么？',
        },
        {
          source: '形如 y = kx + b（k 不等于 0）的函数叫一次函数。',
          explain: '再看 b。b 不影响“是不是一次函数”，但它决定直线和 y 轴交在哪里。把 x 代成 0，y 就等于 b，所以 b 就是截距。很多同学把 b 当成斜率，问题就出在没有代 x 等于 0 去验一遍。',
          check: 'b 决定的是斜率还是截距？',
        },
      ],
    },
    {
      title: 'k 的符号决定方向',
      source: '第 2 页',
      minutes: 6,
      keyPoints: ['k 大于 0 上升', 'k 小于 0 下降'],
      segments: [
        {
          source: 'k 大于 0 时，y 随 x 增大而增大。',
          explain: '这一句是判断单调性的全部依据。k 大于 0，x 往前走，y 跟着往上走，直线从左下到右上。你可以取两个点验：x 取 0 和 1，y 分别等于 b 和 k 加 b，因为 k 是正的，第二个点一定更高。',
          check: 'k 小于 0 时，直线往哪个方向走？',
        },
        {
          source: 'k 大于 0 时，y 随 x 增大而增大。',
          explain: '别把“增大”理解成“越来越快”。一次函数的增大是匀速的，每走一个单位 x，y 就固定增加 k，所以图像才是直线而不是曲线。这一点和二次函数正好相反。',
          check: '一次函数的增长是匀速还是加速？',
        },
      ],
    },
  ],
}

const SUMMARY = {
  overview: '你这次跟完了两讲，能说出一次函数的形式与 k 的作用；截距和斜率还容易混。',
  mastered: ['一次函数的形式 y = kx + b', 'k 大于 0 时图像上升'],
  weak: ['b 与截距的对应关系还要再讲一遍'],
  pitfalls: ['把 b 当成斜率', '把匀速增大的图像想成曲线'],
  next: ['用两道题分别求 k 和 b，再画一遍图像'],
}

function reply(content) {
  return JSON.stringify({
    id: 'fake',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 640 },
      completion_tokens: 380,
    },
  })
}

const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    if (request.url?.includes('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-vision' }] }))
      return
    }
    let content = '这句的关键是 k 与 b 各管一件事：k 管方向，b 管起点。'
    if (raw.includes('请先把这张课件页读懂')) {
      content = '## 知识点\n1. 直线过点 (0, b)，斜率是 k。\n## 概念关系\nk 决定倾斜方向，b 决定与 y 轴的交点。\n## 讲课提示\n先让学生代 x=0 验证 b。'
    } else if (raw.includes('课件阅读器')) {
      const range = /页码范围：(.+?)。/.exec(raw)?.[1] ?? '第 1 页'
      content = JSON.stringify({
        range,
        topics: ['一次函数的形式'],
        keyPoints: ['y = kx + b，k 不为 0', 'b 是截距'],
        quotes: ['形如 y = kx + b（k 不等于 0）的函数叫一次函数。', 'k 大于 0 时，y 随 x 增大而增大。'],
        formulas: ['y = kx + b'],
        examples: [],
        pitfalls: ['把 b 当成斜率'],
      })
    } else if (raw.includes('课程设计')) {
      content = JSON.stringify(PLAN)
    } else if (raw.includes('学习分析')) {
      content = JSON.stringify(SUMMARY)
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(reply(content))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-ai] listening on http://127.0.0.1:${port}/v1`)
})
