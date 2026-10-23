## 1. HTTP 入口

- [x] 1.1 补真实HTTP失败回归并记录Red；复用issue已给出的读取顺序观察。
- [x] 1.2 实现128KiB原始字节流上限、既有身份/CSRF前置及Content-Length预检。
- [x] 1.3 定义并实现413/400 envelope、请求id一致、未消费流的响应后关闭和中断清理。

## 2. 验证与收口

- [x] 2.1 真实HTTP覆盖小JSON、无会话/CSRF不结束上传、单块/分块/UTF8边界、畸形JSON、连接结束；记录同用例Green与有限上传观察（D8传输合同扩展，不提升既有healthz双跑声明）。
- [x] 2.2 使用新隔离PG16验证正常会话/CSRF、批准确认、对话SSE和任务取消；保留事务/冻结保证（A1/A2、D3/D5/D9）。
- [ ] 2.3 根verify/contracts及相关PG测试通过，同步design/API/PRD/索引，记录未覆盖边界；五checks成功。
- [x] 2.4 完成OpenSpec archive，最终实现PR Closes #43（不自行合并）。

## 执行证据

- Spec-only #50 经主线程独立审阅及五门成功后squash；实现基于该spec，并集成#42后的main。
- Red：在实现前运行`bun run build:packages && bun test apps/api/test/http-body.test.ts`，首条真实HTTP无会话未结束上传因1500ms内无响应失败；同轮还有旧app上传中断未捕获的噪声，未将其计作独立Red。更早的依赖链接失败不算Red。
- Green：根`bun run verify` 10步成功，177 tests通过（含9条HTTP边界）；`bun run test:contracts` 15通过。日志观察：三个受保护路由1035字节未结束上传均401并关闭；UTF8 131072字节可达业务验证，131073字节未结束分块上传413并关闭。
- 本地PG证据适用于`ddec097`的HTTP实现快照（集成#42之前）：新隔离PG16、Linux Bun1.4.2原Dockerfile构建后执行根`bun run test:integration`，129通过/15文件；真实签名会话/CSRF、SSE完成、冻结确认重放唯一task、HTTP连接复用与取消提交均覆盖；无撤销回执时保留cancel_pending。最终集成HEAD的全套结果另见PR的migration-scan。
- Windows全PG尝试曾发生Bun worker原生崩溃，另一次整套600秒未结束；随后使用同版本Linux Bun完成全套，不把平台失败说成业务Red。测试开发中修正了错误的cancelled预期和多余不存在的排序列，旧伪POST夹具改为真正可暂停的Readable以保留异步认证期间字节。
- 未覆盖：DoS/内存或吞吐压测、代理缓冲、慢连接超时、大文件上传；不声称新Harness双跑或重验旧部署/完整v0验收。最新集成版本的五门结果见实现PR，主线程按#42→#43→#44合并。
- #54首次集成CI：static、contracts-dual、scheduler-fault、compose-smoke通过；migration-scan为133通过/1失败（总134/15文件），失败在既有`approvals-revise.test.ts:364` first-writer断言，a/b实际错误未输出，不据此推断根因。主线程接管独立诊断，未重跑碰绿；2.3在五门完成前保持未勾。归档已完成，PR https://github.com/BqLee-AI/Along-agent/pull/54 由主线程合并。
