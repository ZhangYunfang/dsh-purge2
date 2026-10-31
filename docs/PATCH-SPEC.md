# 补丁规格

## 一条补丁长什么样

```js
{
  id: "S3",                      // 稳定标识（写进 state / 证据）
  name: "READ_CAPS_RAISED",
  layer: "code",                  // prompt | code | tool | compat
  group: "tool-caps",             // UI 合并展示用
  targets: [{ pkg: "dsh-tool-fs", rel: ["lib", "index.js"] }],
  variants: [                     // 变体链：按宿主轨道挑，版本不符直接不参与
    {
      track: ["legacy-0.1"],
      ops: [
        { pattern: "const READ_LIMIT = 2e3;", replace: "const READ_LIMIT = 2e4;", expect: 1 },
      ],
    },
  ],
  markers: ["READ_LIMIT = 2e4"],  // 幂等标记，命中即 already
  why: "这层没了会发生什么",        // 自检/面板直接展示
  verify: "怎么证明它生效",         // 证据链用
  optional: false,                // 文件不存在时静默跳过
  defaultOff: false,              // true = 需显式开启
}
```

## 新增一条补丁的流程

1. **先 probe 再写**：拿真实产物数一遍锚点出现次数，不要凭上游 pattern 猜
   ```bash
   grep -c "<你的锚点>" ~/.dsh/profiles/node_modules/@deepseek-ai/<pkg>/lib/index.js
   ```
2. **缩进是 tab**：0.1.2 产物用 `\t`，用空格一条都匹配不上
3. **`expect` 写真实次数**：多行 pattern 的每条 op 都要给
4. **给 `markers`**：取替换后独有的一段文本（含 `[dsh-purge2]` 标记最好）
5. **写 `why` 与 `verify`**：`why` 回答"没有它会发生什么"，`verify` 回答"怎么证明它在"
6. 跑 `node bin/dsh-purge2.js plan` 确认状态是 `pending` 且命中数符合预期
7. 跑 `npm test` 确认幂等 / 拒写 / plan 只读三项仍绿

## 什么情况不要写补丁

| 场景 | 该用什么 |
| --- | --- |
| 行为由 Config schema 暴露 | **config 通道**，写进 `cordis.patch.yml` |
| 宿主有事件/瀑布接缝 | **runtime 通道**，`ctx.on(...)` 挂上去 |
| 只在某版本对的代码才有 | 加 `variants[].track`，不要写成 `try/catch 尽力而为` |
| 会削弱宿主自我保护 | 标 `defaultOff: true`，并在 `why` 里写明代价 |
