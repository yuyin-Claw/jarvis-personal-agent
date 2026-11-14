# JARVIS System Architecture

> 版本 0.1 · 状态 Draft · 提取自《Omarchy改造目标》备忘录（2026-11-14）

JARVIS Personal Agent
System Architecture（系统架构设计）
版本： 0.1 状态： Draft 架构风格： Modular Monolith + Event-Driven Runtime + Pluggable Harness 部署平台： Omarchy / Arch Linux / Hyprland 首期部署模式： Single-user Local Runtime
1. 架构目标
本架构需要解决五个核心问题：
如何让一个中央 Agent 长期运行并保持统一人格？
如何让它持续理解用户的数字环境？
如何调度不同 Harness，而不依赖某个执行环境的内部实现？
如何让它在后台持续工作并主动联系用户？
如何让它自主创造新的执行能力，同时不突破安全边界？
架构原则：
Central Intelligence。
Event-Driven。
Persistent Runtime。
Pluggable Execution。
Ambient Context。
Permission by Design。
Platform Independence。
第一版采用模块化单体，而不是微服务。
核心服务可以运行在同一台机器、同一套代码仓库中，但模块之间必须保持明确的接口边界。
2. 总体系统架构
flowchart TB
    USER["User"]
    subgraph UI["Interaction Layer"]
        AVATAR["JARVIS Avatar"]
        CHAT["Conversation Interface"]
        VOICE["Voice Interface"]
        DYNAMIC["Dynamic UI Host"]
        NOTIFY["Notification Service"]
    end
    subgraph CORE["Central Intelligence Layer"]
        GATEWAY["Conversation Gateway"]
        ORCH["Central Orchestrator"]
        LLM["LLM Gateway"]
        MEMORY["Memory Engine"]
        TASK["Task Manager"]
        PROACTIVE["Proactive Engine"]
    end
    subgraph CONTEXT["Context Awareness Layer"]
        BUS["Event Bus"]
        COLLECTOR["Context Collectors"]
        PERCEPTION["Perception Engine"]
        BUILDER["Context Builder"]
        POLICY["Privacy Filter"]
    end
    subgraph EXEC["Execution Layer"]
        ROUTER["Harness Router"]
        RUNTIME["Harness Runtime"]
        FACTORY["Harness Factory"]
        REGISTRY["Capability Registry"]
        CODEX["Codex Harness"]
        CLAUDE["Claude Code Harness"]
        MCP["MCP Servers"]
    end
    subgraph SYSTEM["System Integration Layer"]
        HYPR["Hyprland Adapter"]
        PORTAL["XDG Portal"]
        PIPEWIRE["PipeWire"]
        FILES["File Watcher"]
        AUDIO["Audio Adapter"]
    end
    USER --> AVATAR
    USER --> CHAT
    USER --> VOICE
    AVATAR --> GATEWAY
    CHAT --> GATEWAY
    VOICE --> GATEWAY
    GATEWAY --> ORCH
    ORCH --> LLM
    ORCH --> MEMORY
    ORCH --> TASK
    ORCH --> ROUTER
    ORCH --> PROACTIVE
    COLLECTOR --> BUS
    BUS --> POLICY
    POLICY --> PERCEPTION
    PERCEPTION --> BUILDER
    BUILDER --> MEMORY
    BUILDER --> ORCH
    ROUTER --> RUNTIME
    RUNTIME --> CODEX
    RUNTIME --> CLAUDE
    RUNTIME --> MCP
    FACTORY --> RUNTIME
    FACTORY --> REGISTRY
    REGISTRY --> ROUTER
    HYPR --> COLLECTOR
    PORTAL --> COLLECTOR
    PIPEWIRE --> COLLECTOR
    FILES --> COLLECTOR
    AUDIO --> COLLECTOR
    PROACTIVE --> NOTIFY
    GATEWAY --> DYNAMIC
    ORCH --> AVATAR
3. 系统模块设计
3.1 JARVIS Core
核心模块，负责所有面向用户的智能决策。
子模块：
Conversation Gateway
Central Orchestrator
LLM Gateway
Memory Engine
Task Manager
Proactive Engine
核心职责：
统一管理人格。
处理用户输入。
读取相关记忆。
分析当前上下文。
制定任务计划。
调度 Harness。
管理长期目标。
决定主动沟通时机。
不负责直接访问屏幕、麦克风或执行任意 Shell。
3.2 Conversation Gateway
统一交互入口。
接口：
interface ConversationGateway {
  receive(input: UserInput): Promise<void>;
  streamResponse(
    conversationId: string
  ): AsyncIterable<AgentMessage>;
  interrupt(
    conversationId: string
  ): Promise<void>;
}
职责：
对话会话管理。
消息路由。
流式响应。
中断控制。
上下文加载。
多模态输入接入。
数字人、文字界面和语音界面都使用同一 Gateway。
3.3 Central Orchestrator
整个系统的中央决策器。
核心工作流程：
Receive Input
     |
     v
Load User Context
     |
     v
Understand Intent
     |
     v
Retrieve Memory
     |
     v
Decide Action
     |
     +---- Answer Directly
     |
     +---- Ask User
     |
     +---- Start Harness
     |
     +---- Continue Existing Task
     |
     +---- Create New Capability
     |
     v
Verify Result
     |
     v
Update Memory
     |
     v
Communicate
要求：
每次决策都有任务上下文。
任务必须能够恢复。
重要决策应记录。
工具执行必须经过权限检查。
对模型输出进行结构化解析和校验。
建议采用有限状态工作流，不允许模型直接无限循环调用工具。
3.4 LLM Gateway
统一模型接入层。
接口：
interface LLMProvider {
  generate(
    request: LLMRequest
  ): AsyncIterable<LLMResponse>;
  getModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<boolean>;
}
支持：
OpenAI API。
Anthropic API。
OpenAI-compatible API。
本地模型服务。
模型选择由 Orchestrator 决定。
建议把人格 Prompt、任务 Prompt、Harness Prompt 分开管理。
3.5 Memory Engine
第一版使用 SQLite。
建议数据分为：
memory/
├── user_profile
├── conversations
├── conversation_summaries
├── projects
├── goals
├── decisions
├── experiences
└── memory_links
记忆分类：
￼
记忆写入机制：
Conversation / Activity
          |
          v
Memory Candidate
          |
          v
Privacy Check
          |
          v
Importance Evaluation
          |
          v
Deduplication
          |
          v
Memory Store
重要原则：
原始上下文不等于长期记忆。
推断信息必须标记置信度。
记忆应保留来源和创建时间。
用户可以查看、纠正和删除。
不允许未经授权保存敏感内容。
后续可引入向量检索和 Graphify，但第一版不要将知识图谱作为运行前提。
3.6 Task Manager
所有长期执行任务必须由 Task Manager 管理。
建议使用 SQLite 持久化任务状态。
核心结构：
interface AgentTask {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  harnessId?: string;
  harnessJobId?: string;
  contextRefs: string[];
  dependencies: string[];
  requiresApproval: boolean;
  result?: TaskResult;
}
任务必须支持：
创建。
暂停。
恢复。
取消。
重试。
依赖关系。
任务历史。
产物管理。
任务状态与 Harness 进程状态必须分开。
例如，Harness 进程已经退出，不意味着任务一定成功。
3.7 Proactive Engine
负责让 JARVIS 成为持续存在的 Agent。
输入：
用户长期目标。
当前任务状态。
系统事件。
活动上下文。
用户通知偏好。
定时事件。
处理流程：
Trigger
   |
   v
Rule Evaluation
   |
   v
Context Enrichment
   |
   v
Priority Scoring
   |
   v
Interruption Policy
   |
   +---- Suppress
   |
   +---- Prepare
   |
   +---- Notify User
主动性等级：
￼
建议将 L0-L2 作为基础默认行为，L3 按任务和权限授权，L4 必须执行审批策略。
4. Harness Architecture
4.1 Harness 的定位
Harness 是 JARVIS 调用的执行环境。
JARVIS 不应该重新实现 Codex、Claude Code 的内部执行机制。
应该通过 Adapter 连接不同 Harness。
4.2 Harness Adapter
统一接口：
interface HarnessAdapter {
  id: string;
  getCapabilities(): Promise<Capability[]>;
  healthCheck(): Promise<HealthStatus>;
  execute(
    task: HarnessTask
  ): Promise<HarnessJob>;
  getStatus(
    jobId: string
  ): Promise<HarnessJobStatus>;
  streamEvents(
    jobId: string
  ): AsyncIterable<HarnessEvent>;
  cancel(
    jobId: string
  ): Promise<void>;
}
4.3 第一批 Harness
Codex Adapter
主要负责：
软件开发。
代码修改。
自动化测试。
项目维护。
工程工具开发。
Claude Code Adapter
主要负责：
复杂代码分析。
架构研究。
代码审查。
辅助开发和验证。
具体能力应根据对应产品实际支持的 CLI、SDK 和授权机制确定。
不能假设两个 Harness 拥有完全一致的接口。
4.4 Harness Runtime
负责：
进程管理。
工作目录分配。
环境变量管理。
资源限制。
执行超时。
日志收集。
输出解析。
产物管理。
取消和恢复。
建议初期使用独立子进程，并将项目目录作为明确的工作范围。
后续增加 Podman 或 bubblewrap 沙箱。
4.5 Harness Factory
能力创建流程：
Capability Gap
      |
      v
Capability Design
      |
      v
Coding Harness
      |
      v
Build
      |
      v
Sandbox Test
      |
      v
Security Review
      |
      v
User Approval if Needed
      |
      v
Capability Registry
      |
      v
Harness Router
Factory 可以创建：
Harness Adapter。
Skill。
MCP Server。
系统工具。
自动化工作流。
能力注册和权限授予必须分开。
新能力默认没有超出其明确声明范围的权限。
5. Context Awareness Architecture
5.1 感知来源
Omarchy / Linux
      |
      +---- Hyprland IPC
      |
      +---- XDG Desktop Portal
      |
      +---- PipeWire
      |
      +---- File Events
      |
      +---- Browser Extension
      |
      +---- Audio Input
      |
      v
Context Collector
5.2 Context Collector
每一种数据来源独立实现 Adapter。
interface ContextSource {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<SourceStatus>;
  subscribe(
    handler: (event: ContextEvent) => void
  ): Promise<void>;
}
首期来源：
Window Source。
File Source。
Screen Source。
Audio Source。
Browser Source。
5.3 Event Bus
统一事件格式：
interface ContextEvent {
  id: string;
  source: string;
  type: string;
  timestamp: string;
  sensitivity: SensitivityLevel;
  payload: Record<string, unknown>;
  confidence?: number;
}
所有事件必须经过 Permission Broker。
不得允许 Context Collector 直接向 LLM 发送原始数据。
5.4 Context Builder
把不同来源的信息整合成活动上下文。
例如：
{
  "activity_id": "activity-001",
  "project": "evidence-collector",
  "application": "code",
  "activity": "editing_mcp_server",
  "related_documents": [],
  "recent_events": [],
  "inferred_goal": "implement_mcp_registry",
  "confidence": 0.82,
  "evidence_refs": []
}
其中：
activity 可以是推断。
inferred_goal 必须保留推断属性。
evidence_refs 指向支持该判断的事件。
置信度不能被当作真实性证明。
5.5 Screen Awareness
技术路径：
XDG ScreenCast Portal
          |
          v
Portal Session
          |
          v
PipeWire Stream
          |
          v
Frame Sampling
          |
          v
OCR / Vision Model
          |
          v
Sensitive Content Filter
          |
          v
Context Builder
默认使用用户明确授权的屏幕或窗口来源。
不允许绕过 Portal 进行隐蔽屏幕采集。
5.6 Voice Awareness
技术路径：
Microphone
    |
    v
Local Wake Word / VAD
    |
    v
Audio Session
    |
    v
ASR
    |
    v
Privacy Filter
    |
    v
Context Builder
默认不保存原始音频。
会议和多人对话需要明确启动和状态提示。
6. Permission & Privacy Architecture
6.1 Permission Broker
独立于 Orchestrator。
任何感知和执行动作必须经过 Permission Broker。
权限范围：
Screen Capture。
Microphone。
Camera。
File Read。
File Write。
Browser Context。
Clipboard。
Shell Execution。
System Control。
Network Access。
Harness Execution。
6.2 权限决策
Action Request
      |
      v
Identify Source
      |
      v
Check Permission
      |
      v
Check Scope
      |
      v
Check Risk
      |
      +---- Deny
      |
      +---- Allow
      |
      +---- Ask User
      |
      v
Audit Log
6.3 数据生命周期
￼
6.4 隐私模式
支持：
Ambient。
Focus。
Private。
Meeting。
Private 模式必须能够立即暂停屏幕和麦克风采集。
屏幕锁定、会话注销和敏感应用状态也需要纳入策略。
6.5 Harness 隔离
Harness 不直接获得：
全局屏幕流。
原始麦克风流。
全部用户文件。
全局剪贴板。
未授权凭证。
JARVIS 根据具体任务构建最小化 Context Package。
7. Omarchy System Integration
7.1 Platform Adapter
JARVIS 不直接依赖 Omarchy 内部实现。
建立：
JARVIS Core
     |
     v
Platform Adapter
     |
     v
Omarchy Adapter
     |
     +---- Hyprland IPC
     +---- XDG Portal
     +---- PipeWire
     +---- D-Bus
     +---- systemd
     +---- File Watcher
     +---- Notification
7.2 Hyprland Adapter
负责：
活动窗口变化。
工作区变化。
窗口元数据。
受控窗口操作。
系统事件订阅。
通过 Hyprland IPC 获取信息。
IPC Socket 不允许直接暴露给 Harness。
7.3 XDG Portal Adapter
负责：
ScreenCast。
RemoteDesktop（后续需要时）。
用户授权会话。
会话恢复。
屏幕来源管理。
7.4 PipeWire Adapter
负责：
屏幕视频流。
音频流。
采样和缓冲。
流状态管理。
7.5 systemd Integration
建议初期部署：
jarvis-core.service
jarvis-context.service
jarvis-harness.service
jarvis-avatar.service
其中桌面感知服务应绑定到当前用户图形会话。
后台任务服务可以独立于数字人窗口运行。
不要让用户退出桌面后，屏幕采集继续运行。
7.6 用户目录
建议：
~/.local/share/jarvis/
    database/
    memory/
    tasks/
    artifacts/
    logs/
    audit/
/home/user/.config/jarvis/
    config.toml
    permissions.toml
    models.toml
    harnesses/
/home/user/.local/bin/
    jarvis
凭证使用系统 Secret Service 或其他受保护的凭证存储机制，不应写入普通配置文件。
8. 数据库设计
第一版采用 SQLite。
核心表：
users
conversations
messages
projects
goals
decisions
memories
memory_links
tasks
task_dependencies
task_events
task_artifacts
harnesses
harness_jobs
harness_events
capabilities
context_events
activities
context_snapshots
permissions
permission_grants
audit_logs
notifications
scheduled_jobs
设计原则：
任务数据与对话数据分离。
事件数据与长期记忆分离。
原始数据与摘要数据分离。
权限记录独立于业务数据。
任务执行状态可以恢复。
数据库支持迁移和备份。
初期不需要独立部署 Redis、Kafka 或 PostgreSQL。
9. Continuous Runtime
9.1 Runtime Loop
System Event / User Message / Timer
                |
                v
           Event Queue
                |
                v
          Event Processor
                |
                v
          Policy Evaluation
                |
                v
        Context Enrichment
                |
                v
          Orchestrator
                |
                v
          Action Decision
                |
       +--------+--------+
       |        |        |
       v        v        v
     Ignore   Prepare   Execute
       |        |        |
       +--------+--------+
                |
                v
           Result Check
                |
                v
          Memory Update
                |
                v
         User Communication
9.2 运行机制
使用：
Event-driven processing。
Scheduled checks。
Task polling only where necessary。
Bounded model calls。
Persistent job state。
避免无意义的持续模型推理。
9.3 恢复机制
服务崩溃后恢复任务状态。
Harness 状态与任务状态分开处理。
网络异常不丢失任务。
未完成任务需要明确标记。
不确定是否完成时先核实，不能盲目重复执行。
10. 动态 UI Architecture
动态 UI 不属于中央 Agent 的核心业务逻辑。
单独提供 UI Host。
JARVIS
   |
   v
UI Request
   |
   v
Harness Generates UI
   |
   v
Artifact Validation
   |
   v
Restricted UI Host
   |
   v
User
要求：
运行环境隔离。
受限数据接口。
用户明确授权后才能执行敏感操作。
UI 不能自行扩大权限。
支持关闭和重新打开。
支持静态 HTML、图表和交互式应用。
11. 推荐技术栈
￼
技术选型原则：
不要为了技术先进而过度引入组件。
第一版优先稳定性、可调试性和开发效率。
12. Repository Structure
jarvis/
│
├── apps/
│   ├── desktop/
│   └── daemon/
│
├── packages/
│   ├── core/
│   ├── orchestrator/
│   ├── llm-gateway/
│   ├── memory/
│   ├── task-manager/
│   ├── proactive/
│   ├── harness-runtime/
│   ├── harness-factory/
│   ├── capability-registry/
│   ├── context-engine/
│   ├── permission-broker/
│   └── event-bus/
│
├── adapters/
│   ├── omarchy/
│   ├── hyprland/
│   ├── xdg-portal/
│   ├── pipewire/
│   ├── codex/
│   ├── claude-code/
│   └── mcp/
│
├── perception/
│   ├── screen/
│   ├── voice/
│   ├── ocr/
│   └── vision/
│
├── interface/
│   ├── avatar/
│   ├── conversation/
│   └── dynamic-ui/
│
├── skills/
├── tests/
├── docs/
└── scripts/
13. 开发阶段
Phase 1：Central Core
交付：
Conversation Gateway。
LLM Gateway。
Central Orchestrator。
SQLite Memory。
Task Manager。
基础桌面入口。
验收：用户可以与 JARVIS 对话，并获得有上下文的持续交互。
Phase 2：Harness Runtime
交付：
Harness Adapter。
Codex Adapter。
Claude Code Adapter。
执行日志。
任务恢复。
产物管理。
基础权限隔离。
验收：JARVIS 可以自主调度两个 Harness 完成真实任务。
Phase 3：Continuous Runtime
交付：
systemd 后台服务。
Event Bus。
Scheduler。
Proactive Engine。
Notification。
长期任务管理。
验收：关闭对话窗口后，JARVIS 仍能运行和主动沟通。
Phase 4：Context Awareness
交付：
Hyprland Adapter。
File Watcher。
XDG Portal。
PipeWire。
OCR / Vision。
Voice Pipeline。
Activity Timeline。
验收：JARVIS 能够理解授权范围内的数字活动。
Phase 5：Harness Factory
交付：
Capability Discovery。
Harness Builder。
Skill Builder。
MCP Builder。
Sandbox Testing。
Capability Registry。
验收：JARVIS 能够创建、验证并注册新的能力。
Phase 6：Full Experience
交付：
数字人。
语音交互。
Dynamic UI。
更完善的 Memory。
主动任务协作。
验收：形成完整的 Personal Agent 使用体验。
14. 测试策略
Unit Tests
测试：
Orchestrator。
Memory。
Task State Machine。
Permission Broker。
Harness Router。
Proactive Policy。
Integration Tests
测试：
Core + LLM。
Core + Harness。
Core + Memory。
Hyprland + Context Engine。
Portal + PipeWire。
systemd + Background Runtime。
Simulation Tests
建立模拟 Context Event：
{
  "type": "active_window_changed",
  "application": "code",
  "project": "evidence-collector",
  "timestamp": "2026-11-14T10:30:00Z"
}
验证：
活动识别是否正确。
项目关联是否准确。
是否产生错误主动提醒。
是否错误启动 Harness。
是否违反权限限制。
Security Tests
重点测试：
恶意 Skill。
恶意 MCP Server。
Prompt Injection。
未授权文件访问。
屏幕和麦克风越权。
Harness 沙箱逃逸风险。
动态 UI 的权限绕过。
15. 第一版架构验收标准
JARVIS 0.1 必须通过以下测试：
单一对话入口能够接收和处理用户需求。
同一个人格能够跨会话使用历史记忆。
能够调用 Codex 和 Claude Code。
能够获得 Harness 执行状态。
聊天窗口关闭后任务仍然继续。
后台服务重启后能够恢复未完成任务。
用户能够取消执行中的任务。
JARVIS 能够主动向用户发送通知。
每次 Harness 执行都有可追踪记录。
未授权的系统操作会被拒绝。
敏感上下文不会被无条件传递给 Harness。
不依赖 Omarchy 私有脚本才能运行核心功能。
16. 当前待确认的架构决策
以下内容应在实现前通过原型验证，而不是直接假定：
Codex 与 Claude Code 的具体 CLI / SDK 接入方式。
主模型和备用模型的选择。
本地模型的部署方式。
语音唤醒和 ASR 的具体实现。
数字人采用 Tauri 原生窗口还是独立桌面进程。
ScreenCast 会话恢复与锁屏策略。
Harness 沙箱的具体隔离级别。
Memory 后续是否采用 Graphify 作为知识关系层。
动态 UI 的运行隔离机制。
未来 Android 端与 Linux 端共享记忆和任务的协议。
这些问题不应阻止第一阶段开发。
17. 最终架构原则
JARVIS 的核心永远是统一的 Central Intelligence。
Harness 是执行能力，不是用户交互入口。
Context Awareness 是环境理解能力，不是无差别的数据采集。
Memory 是长期认知基础，不是原始数据仓库。
Proactive Engine 是主动沟通机制，不是无休止的自动化任务。
Harness Factory 是能力扩展机制，不是绕过权限的自我修改机制。
Omarchy 是首个系统宿主，不是 JARVIS 的架构边界。
最终目标：打造一个始终存在、理解用户、主动沟通、能够自主执行并持续扩展能力的 Personal Agent。
两份文档完成后的几个重要建议
我建议你先不要急着把所有模块交给 Codex 开发。有三个地方需要特别注意：
先跑通 Core + Harness + Task Manager。 这是 JARVIS 的骨架，其他模块都围绕它扩展。  
持续运行必须先于 Ambient 感知。 先让它真正具备后台存在、主动沟通的能力，再让它学会看和听。  
Harness Factory 最后实现。 否则在基础权限、任务管理和执行审计尚未稳定时，就让系统自主创建执行能力，风险比较大。  
我建议的下一步
把这两份文档进一步转化成：
Codex 可以直接执行的开发任务。  
每个模块的接口定义和数据结构。  
GitHub Issue / Milestone。  
第一阶段的项目初始化和目录结构。  
每个开发任务对应的验收测试。  
这样就可以真正开始工程开发，而不是继续停留在架构讨论阶段。
要不要下一步直接把 JARVIS 0.1 拆成 Codex 可执行的开发任务，并每周检查实施进度？