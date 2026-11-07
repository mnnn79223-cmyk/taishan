# 小红净图解析服务

用于测试云端小红书公开笔记解析。Node.js 22+，无第三方运行依赖。

启动：`node server.mjs`。必须设置至少 32 字符的随机 `PARSER_KEY`；Render 使用免费 Web Service。

`GET /health` 为健康检查，`POST /parse` 需要 `Authorization: Bearer <PARSER_KEY>`，JSON 请求体为 `{ "url": "分享链接" }`。

不保存用户分享链接。部署后仍需验证平台是否允许访问。
