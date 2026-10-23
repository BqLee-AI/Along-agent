## 1. HTTP 入口

- [ ] 1.1 补真实HTTP失败回归并记录Red；复用issue已给出的读取顺序观察。
- [ ] 1.2 实现128KiB原始字节流上限、既有身份/CSRF前置及Content-Length预检。
- [ ] 1.3 定义并实现413/400 envelope、请求id一致、未消费流的响应后关闭和中断清理。

## 2. 验证与收口

- [ ] 2.1 真实HTTP覆盖小JSON、无会话/CSRF不结束上传、单块/分块/UTF8边界、畸形JSON、连接结束；记录同用例Green与有限上传观察（D8传输合同扩展，不提升既有healthz双跑声明）。
- [ ] 2.2 使用新隔离PG16验证正常会话/CSRF、批准确认、对话SSE和任务取消；保留事务/冻结保证（A1/A2、D3/D5/D9）。
- [ ] 2.3 根verify/contracts及相关PG测试通过，同步design/API/PRD/索引，记录未覆盖边界；五checks成功。
- [ ] 2.4 完成OpenSpec archive，最终实现PR Closes #43（不自行合并）。
