# BGE small Chinese v1.5 模型许可说明

本说明仅覆盖外部挂载的模型权重，不改变项目自身许可，也不代表完整编码服务镜像的许可清算。本目录及镜像均不包含模型权重。

## 模型与固定资产

- 原始模型发布者：**BAAI**，`BAAI/bge-small-zh-v1.5`，revision `7999e1d3359715c523056ef9478215996d62a620`。
- ONNX/量化发布者：**Xenova**，`Xenova/bge-small-zh-v1.5`，revision `75c43b069aac4d136ba6bc1122f995fedcfd2781`。
- 资产：`onnx/model_int8.onnx`，**23,903,394 字节**，SHA-256 `b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5`。
- 来源：[固定原始模型卡](https://huggingface.co/BAAI/bge-small-zh-v1.5/blob/7999e1d3359715c523056ef9478215996d62a620/README.md)、[固定量化模型卡](https://huggingface.co/Xenova/bge-small-zh-v1.5/blob/75c43b069aac4d136ba6bc1122f995fedcfd2781/README.md)。

## 许可依据与推断边界

原始模型卡声明 MIT，并明确允许免费商用；量化模型卡将该 BAAI 模型列为 base model。审阅的固定 Xenova 仓库缺少 license 元数据字段及 LICENSE 文件；本说明不表示上游已补许可标签或作出本型号专属许可修订。

**2026-02-10 19:47:02 UTC**，Xenova 原话：

> Hi there 👋 Yep, all quantizations I have made should fall under the same license of the original model. I'll update the repo accordingly.

[发布者原始评论](https://huggingface.co/Xenova/bge-m3/discussions/9#698b8b36426c7281cce51330)。

**[INFERENCE]** 将“all quantizations”声明用于此 BGE small INT8 固定 revision，是基于其措辞及量化仓库 base-model 链接的有依据推断。评论位于**不同型号 `bge-m3` 的讨论**，不是当前型号的专属声明。MIT 判断基于上述证据组合，不宣称上游已明确声明此量化 revision 的许可。

随附 `LICENSE` 保留上游 MIT 许可原字节，包括 `Copyright (c) 2022 staoxiao`，来源为 [FlagEmbedding 固定 LICENSE](https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/c086741f5e117b7b8ce1745ea00b6c262f281a01/LICENSE)。MIT 允许使用、修改、分发及商用，但须保留版权和许可声明，并适用其免责条款。再分发模型或其实质部分时，应保留这些声明。

`provenance.json` 记录来源 URL 及保存的原始证据响应内容 SHA-256；这些 hash 标识证据内容，不保证在线 URL 内容不变。未附带完整 API 响应或个人元数据。

## 覆盖范围

本材料仅说明模型权重许可与来源，**不代表**基础镜像、Python 包、传递/原生依赖、tokenizer 等其他资产已完成许可审查，也不授权部署、发布、enforce 或生产启用。不改变冻结 manifest、binding、历史报告或项目许可。

这些文件随编码服务镜像位于 `/app/third-party/bge-small-zh-v1.5/`，不依赖外部模型挂载。
