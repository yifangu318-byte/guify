# Codex 执行配置（用户定，2026-10-30）

- 模型：gpt-6.1-sol
- 推理：高（high）
- 加速：不开（不启用任何以牺牲推理质量换速度的加速模式）
- 调用方式：`codex exec --skip-git-repo-check -C ~/workspace/muse-erp --approve-for-me -m gpt-6.1-sol -c model_reasoning_effort="high" -`
- 校验：每次 Codex 运行开头应显示 model 为 gpt-6.1-sol、reasoning effort 为 high；若显示为 none 或其他值，不得算作按此配置执行，须停下纠正后重跑。
- 注意：此前 T1、T2 用的是默认模型（烟测默认即 gpt-6.1-sol）但推理档为 none；T3 首次运行同样为默认档，用户 2026-10-30 纠正后已停掉并按本配置重跑。此配置取代此前“gpt-6-luna 高”的旧口径（2026-10-23 故事板任务专用，不适用于 MUSE ERP 开发）。
