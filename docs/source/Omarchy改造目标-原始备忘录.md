# Omarchy改造目标（原始备忘录全文）

> 提取自 Apple Notes，2026-11-14。本文件为原始存档，保留讨论脉络；正式文档见 ../PRD.md 与 ../SYSTEM-ARCHITECTURE.md。

---


ݲ
ղ
Omarchy改造目标
我明白了。这次你的描述让我意识到，我之前把产品想成了一个「AI 操作系统管理平台」，但你真正想做的东西其实更接近 钢铁侠的 JARVIS：一个拥有统一人格、长期记忆和全局控制能力的数字人。
而且，我认为这个方向反而更有产品特色。
我们重新定义一次。
一、我理解的产品：一个数字人，无数双手
Introducing JenAI: An Offline AI Assistant Powered by a Large Language Model | by Andy Sawyer | Medium
medium.com
你不希望用户面对一堆 Agent、工作流、管理面板、模型选择器。
用户只需要认识一个 Agent。
它是用户的数字伙伴，也是整个计算环境的总控。
它负责：
理解用户的想法。  
理解用户的长期目标。  
记住过去的对话和决策。  
判断当前需要完成什么工作。  
决定调用哪个 Harness。  
把任务交给对应的 Harness。  
跟踪执行进度。  
验证和汇总结果。  
最后继续与用户对话。  
底层可以有几十个 Harness、几百个 Skills、不同的 LLM 和 MCP，但用户不需要知道这些东西的存在。
用户只需要跟 JARVIS 说话。
我觉得这可以总结成一句产品原则：
One Persona, One Conversation, Multiple Execution Engines.
一个人格，一个对话入口，多个执行引擎。
二、我建议重新设计整个架构
这次我会把它收敛成四层，而不是之前那种复杂的 Agent 管理平台。
用户唯一接触的对象
Real Life Jarvis AI Assistant for PC (Best Alternatives in 2026)
pikavoice.com
JARVIS · Personal Agent
统一人格、语音、对话、记忆、全局意识
核心大脑
Central Agent Orchestrator
意图理解
任务规划
Harness 路由
上下文管理
执行监督
结果验证
执行层 · 用户不必直接接触
Harness Execution Layer
Codex Harness
代码开发、调试
Claude Code Harness
复杂工程任务
Research Harness
调查、研究、信息收集
Browser Harness
网页操作和浏览
System Harness
操作系统和应用控制
Other Harnesses
未来任意可接入的执行环境
基础设施层
Omarchy / Linux
操作系统、进程、文件、窗口、网络、音频、通知、设备权限
这里有一个关键区别：
Harness 不是你的 Agent，而是你的 Agent 所调用的执行环境。
例如 Codex 本身可以拥有自己的模型、工具、上下文和执行机制。但对于用户来说，它只是 JARVIS 的一双手。
我认为你应该尽可能保留 Harness 原生的能力，而不是重新实现一遍 Codex、Claude Code 的功能。
三、真正重要的是：JARVIS 如何使用 Harness？
我举一个完整的例子。
用户：
帮我研究一下目前开源的 Android AI-native OS，看看能不能和我们现在的 Omarchy 项目形成统一的跨设备架构。
JARVIS 不应该先展示一个 Agent 管理面板，也不应该要求用户自己选择 Harness。
它应该这样工作：
Stop Paying for Five AI Apps | Writingmate
JARVIS
对话示例
帮我研究一下目前开源的 Android AI-native OS，看看能不能和我们现在的 Omarchy 项目形成统一的跨设备架构。
明白。我会先研究 Android 端的系统架构，再对照我们目前的 Omarchy 方案，重点分析跨设备的 Agent Runtime、记忆同步和工具调用机制。
我会把研究和架构分析交给专业执行环境处理。
后台执行
内部调度
Research Harness 查找源码、文档、技术架构。  
Analysis Harness 分析架构差异和技术可行性。  
Document Harness 生成架构报告。  
以上是执行过程的示意，不代表必须同时启动三个 Harness。
AI Chatbots Terminology
JARVIS
研究完成后：
我已经完成了初步研究。我的判断是，两端不必共享操作系统，但应该共享同一个 Agent Identity、Memory Service 和任务协议。
我还整理了一份跨设备架构设计，你可以先看核心结论。
这中间有几个值得特别设计的地方：
JARVIS 不需要亲自执行所有任务。  
它需要知道哪个 Harness 擅长什么。  
它要能够监控 Harness 的运行状态。  
Harness 可以失败、超时、暂停和重试。  
JARVIS 负责向用户解释结果，而不是把 Harness 的原始输出直接扔给用户。  
用户始终只面对一个人格，底层执行可以非常复杂。
四、我认为你最应该重视的创新：动态界面，而不是固定 UI
你刚才有一句话，我觉得非常重要：
除非用户提出，它再自己让 Harness 去生产一个。
这实际上是一个很有意思的设计思想。
传统软件是先有界面，用户通过界面操作功能。
而你的产品可以反过来：
对话是默认界面，其他界面都是按需生成的临时工作空间。
举几个例子：
￼
这些界面不需要预先全部开发。
可以让 Harness 生成 HTML、Web 应用、图表或者可交互的桌面组件，再通过一个统一的 UI Host 呈现。
不过我建议有一个底线：
Harness 可以生成界面，但不能通过生成的界面绕过系统权限控制。
另外，生成的界面应该可以随时打开、关闭、保存和再次调用，而不是每次对话结束就消失。
这意味着你真正需要的不是一个传统 Dashboard，而是一个 On-demand UI Runtime。
五、那么 Omarchy 在这个产品里究竟是什么？
经过你的描述，我反而认为不应该大规模改造 Omarchy。
Omarchy 对你而言主要承担四个角色：
执行环境： 给 Harness 提供 Linux 运行环境。  
系统接口： 让 JARVIS 能操作文件、应用、窗口和设备。  
交互载体： 提供语音、通知、全局快捷键和数字人的显示入口。  
后台宿主： 让 JARVIS 常驻运行。  
我会在 Omarchy 之上安装一个独立的 JARVIS Daemon。
平时它甚至不需要占据屏幕。
用户可以通过：
全局快捷键呼出。  
语音直接唤醒。  
文本对话。  
系统通知。  
后台主动提醒。  
与它交流。
它可以表现为一个数字人，但不一定需要一个始终占据屏幕的 3D 虚拟形象。
你的产品核心不是头像有多漂亮，而是这个人格有连续性、有记忆、有执行能力。
六、我想再向你提出三个更贴近这个方向的问题
这次我不问大量软件功能了，我想进一步理解你心目中的 JARVIS。
问题一：JARVIS 的人格究竟是什么？
你希望它更像：
A. 钢铁侠的 JARVIS：理性、冷静、专业，像一个私人管家。  
B. 一个真正的数字生命：有稳定个性，了解你的习惯，能够提出自己的建议，像长期伙伴。  
C. 一个高度专业的私人 Chief of Staff：不强调人格表现，重点是理解你、协调资源和完成工作。  
问题二：你希望 JARVIS 有多主动？
例如你一周没有打开某个项目，它是否可以主动告诉你：
我注意到你的 Evidence Collector 项目已经一周没有更新了。上次我们讨论的 MCP 权限模块还没有完成，我建议今天继续处理。
它是否可以持续观察任务、主动提出建议，甚至主动启动 Harness 做一些准备工作？
问题三：Harness 对 JARVIS 来说应该是什么？
这是架构上最关键的选择。
A. 固定工具：JARVIS 预先配置好 Codex、Claude Code 等 Harness，根据任务选择。  
B. 动态雇佣：JARVIS 可以根据任务自行寻找、安装、配置新的 Harness。  
C. 自我扩展：JARVIS 不仅能使用 Harness，还能够让 Harness 帮自己开发新的 Harness、Skills 和能力。  
我个人最看好 A 为基础、逐步发展到 C，但必须有用户授权和安全审查。
最后，我想把这款产品的核心理念进一步提炼出来：
JARVIS
Your Personal Intelligence
藍色的人工智能面孔與人對話
一个人格，统一认知，自主调度。
不让用户学习如何使用 AI 工具，而是让 AI 自己学会使用所有工具。
我认为，这才是我们接下来应该围绕 Omarchy 去构建的东西。
这三个答案放在一起，其实已经勾勒出一个很明确的产品方向了。
我现在对你的构想有了一个更准确的理解：
你不是要开发一个能够调用 Harness 的聊天机器人，而是要开发一个能够理解用户、持续陪伴用户，并且能够不断扩展自身能力的数字管家。
我认为第三个选择 C 尤其重要。它会改变整个项目的技术架构。
一、重新定义 JARVIS
Real Life Jarvis AI Assistant for PC (Best Alternatives in 2026)
pikavoice.com
JARVIS
Personal Intelligence · Personal Agent
我建议把产品定义为：
一个拥有稳定人格、长期记忆和系统级行动能力的个人智能体。它能够理解用户的目标，主动关注用户的数字生活，调度现有执行环境，并且能够通过 Harness 不断创造和扩展自己的能力。
它有三个核心属性：
￼
这里有一个我特别想强调的原则：
JARVIS 本身应该始终是同一个 Agent，而不是由多个 Agent 拼起来的一个假象。
它可以拥有不同的执行引擎，但它的记忆、人格、判断和与用户的关系应该保持连续。
二、第三个答案 C，意味着我们要增加一个核心模块
之前的架构只有 Central Agent Orchestrator 和 Harness Execution Layer。
现在我认为应该加入一个更重要的模块：
Harness Factory：能力创造引擎。
它不只是调用 Codex、Claude Code，还能让这些 Harness 帮自己创造新的 Harness、Skills、MCP 和工具适配器。
JARVIS
人格 · 记忆 · 意图理解 · 长期目标
Central Intelligence
理解目标、判断任务、调度能力、监督结果
执行能力
Harness Runtime
Codex、Claude Code、Research、Browser、System 等
创造能力
Harness Factory
发现、设计、构建、测试、注册新的 Harness 和 Skills
Omarchy / Linux System
提供运行环境、系统 API、文件、进程、窗口、网络和设备能力
举个例子：
你告诉 JARVIS：
我希望你帮我建立一个自动收集互联网证据，并且能够形成证据关系图谱的能力。
它应该能够：
判断当前能力库中有没有合适的 Harness。  
发现缺少网页证据采集、来源追踪等能力。  
调度 Coding Harness 开发相关工具。  
创建新的 MCP、Skills 或 Harness Adapter。  
在沙箱里测试。  
完成权限审查后，注册为自己的新能力。  
将来需要证据收集时，直接调用。  
这就很有意思了。
JARVIS 不仅能够使用工具，还能够为自己创造工具。
但是，我建议给自我扩展设置一个原则：能力可以自主开发和测试，但获得新的系统权限、访问敏感数据或者执行高风险操作，仍然需要授权。
三、主动性应该设计成三个层次
你希望它持续观察、主动建议、甚至主动启动 Harness。我建议这样设计：
￼
例如，JARVIS 发现你的某个项目长期没有进展。
它可以先自动检查项目资料、整理现状、启动 Research Harness 搜集新信息，然后主动告诉你：
我发现这个项目有几个值得重新考虑的地方。我已经整理了一份分析，建议我们讨论一下。
这时它不是等你提出任务，而是在帮助你推进长期目标。
我认为这会是产品最有价值的体验之一。
四、JARVIS 最终不应该让用户管理 Harness
这是我希望我们一直坚持的产品原则。
用户不应该需要知道：
当前使用的是哪个模型。  
哪个 Harness 正在执行。  
Skill 安装在哪里。  
MCP Server 如何配置。  
哪个 Agent 负责某个步骤。  
这些都是 JARVIS 自己应该管理的事情。
用户可以随时询问：
你现在有什么能力？
JARVIS 可以向用户解释，也可以按需生成一个能力介绍界面。
用户说：
我想让你获得管理我的服务器的能力。
JARVIS 就自己研究、构建、验证和接入相应能力。
用户不需要打开一个复杂的 Agent 管理控制台。
因此我现在认为，产品的主要交互应该是：
对话优先，数字人呈现，界面按需生成，Harness 隐藏在背后。
五、我想进一步确定一个非常重要的问题
我们现在已经确定人格、主动性和自我扩展能力。
但还有一个会直接影响底层架构的问题：
JARVIS 平时究竟应该感知用户的哪些数字活动？
我提出三个范围：
A. 项目级感知
观察授权的文件夹、项目文件、任务和日程。不主动读取用户当前屏幕。
B. 系统级感知
除了项目资料，还能够了解正在使用的软件、窗口、进程、工作状态和系统事件。
C. 环境级感知
在用户明确授权的情况下，还能够理解屏幕内容、语音及更多实时数字活动，尽可能形成完整的上下文。
确认这个方向
我个人倾向于最终支持 C，但从 B 开始实现，并且让用户明确掌控每一种感知权限。
因为我认为，JARVIS 与普通 Agent 最大的区别之一，就是它不仅知道用户说了什么，还能在授权范围内理解用户正在做什么。
我认为，既然你已经选择了 Ambient（环境级感知），JARVIS 的设计就应该再向前迈一步。
它不应该只是一个能够读取屏幕的 Agent，而应该拥有一种持续的环境理解能力：
JARVIS 能够知道你正在做什么、正在关注什么、目前遇到了什么问题，以及哪些事情可能需要它介入。
例如：
你打开 IDE 并开始修改某个项目，JARVIS 能逐渐理解你正在开发什么。  
你打开一份研究资料，它能够结合此前的项目记忆，理解这份资料为什么重要。  
你与同事讨论一个问题，它在获得授权后能够理解讨论内容，并关联到相应项目。  
你长时间没有推进某个目标，它能够主动检查状态，甚至启动 Harness 进行准备。  
你没有提出任何要求时，它也不必一直打扰你，而是等待真正值得介入的时机。  
但这里有一个关键设计：
Ambient 不等于全天候录屏、录音。Ambient 的本质是持续感知、按需理解、选择性记忆。
我建议把 JARVIS 的环境感知系统设计成一个独立的核心引擎，名字可以叫：
JARVIS Context Awareness Engine
环境感知与上下文理解引擎
它负责收集数字环境的信息，把原始信息转化成有意义的上下文，再交给 JARVIS 的核心人格进行理解和判断。
一、Context Awareness Engine 的整体架构
我建议将它设计成一个独立于 JARVIS 大脑的感知系统。
它不负责回答用户，也不负责执行任务。它只负责理解环境，并为 JARVIS 提供当前上下文。
Ambient Context Sources
屏幕
语音
应用
文件
浏览器
交互事件
第一道关口
Permission & Privacy Broker
判断来源是否允许、是否需要脱敏、是否需要用户确认
Perception Engine
视觉理解
OCR、界面识别
语音理解
ASR、语音意图
应用理解
应用和工作状态
行为理解
事件和操作关联
Context Engine
事件关联 · 当前状态 · 时间线 · 置信度 · 重要性判断
JARVIS
实时上下文和主动判断
Memory Engine
筛选后形成长期记忆
这里我认为最重要的是：感知层与记忆层必须分开。
JARVIS 看到你打开了一份文件，并不意味着就应该把整份文件永久记住。
例如，它可以形成这样的上下文：
时间：14:35
当前应用：VS Code
当前项目：Evidence Collector MCP
当前活动：修改 MCP 工具注册模块
环境状态：用户正在编码
关联记忆：
此前讨论过工具权限与来源追踪。
判断：
可能正在推进 MCP Server 的实现。
置信度：0.82
这是一个经过理解的 Context，而不是原始屏幕截图。
1. 六类感知能力
￼
有一个我特别建议你注意的地方：
不要通过全局键盘记录来实现 Interaction Awareness。
用户输入的内容可以通过对话、主动选取、应用接口等方式理解，不需要监听每一个按键。
二、Ambient 的三个核心感知机制
1. Screen Awareness：让 JARVIS 看见你的数字环境
这是整个系统最具代表性的能力。
我建议把屏幕感知分成三个模式：
What's New for Developers in GNOME 50 - GNOME Release Notes
当前活动窗口
读取用户正在使用的窗口，必要时通过截图理解内容。作为默认视觉感知范围。
Omarchy Linux : j'ai testé la distro Arch clé en main | Brandon Visca
多窗口理解
理解多个应用之间的关系，例如 IDE、浏览器、文档之间的工作关联。
BIT | Best IT training institute in India
全屏环境理解
用户授权后，理解多个显示器、完整工作区和不同应用的组合状态。
技术上不要直接依赖传统 Linux X11 的截屏方式。
Omarchy 使用 Hyprland/Wayland。建议采用：
xdg-desktop-portal-hyprland：获取用户授权的屏幕捕获会话。  
org.freedesktop.portal.ScreenCast：选择屏幕或应用窗口。  
PipeWire：接收屏幕视频流。  
OCR / Vision Model：理解屏幕内容。  
ScreenCast Portal 支持屏幕和窗口两类来源，建立会话时通常会呈现用户选择界面，之后通过 PipeWire 提供数据流。它还支持使用 restore token 恢复持久化会话。
XDG Desktop Portal+1
这意味着你可以设计：
第一次使用时，用户授权 JARVIS 观察当前工作窗口；之后在许可范围内恢复会话，而不是每隔几秒重新询问用户。
但持久化会话不应该等于无限制的永久权限。JARVIS 应当始终提供清晰的感知状态、暂停和撤销入口。
2. Voice Awareness：让 JARVIS 理解声音环境
我建议把语音设计成两个独立功能。
第一种：随时唤醒 JARVIS。
例如：
Hey Jarvis。
本地运行唤醒词检测和语音活动检测（VAD），不需要一直将原始音频发送给云端。
第二种：环境语音理解。
用户进入允许的语音模式后，JARVIS 才进行语音转文字，并关联到当前项目和任务。
例如：
你正在讨论一个技术问题，JARVIS 可以在授权的会议模式下提取讨论内容、决策和待办事项。
我特别建议：
唤醒词检测在本地运行。  
语音转文字默认优先使用本地模型。  
原始音频不默认保存。  
会议或多人对话有明显的录音状态提示。  
云端模型只收到必要的文字摘要，除非用户另行授权。  
Omarchy 4.5 已经提供 Superwhisper 语音输入，并且支持切换本地模型。不过其默认配置从云端开始，因此不能直接将现有听写配置当作全天候 JARVIS 的隐私方案。
Omarchy News
3. Activity Awareness：让 JARVIS 理解你正在做什么
这可能是最容易被忽略、但长期价值最大的能力。
举个例子：
你先打开浏览器查资料，然后打开 VS Code 修改代码，接着打开文档整理设计。
如果只看单个截图，JARVIS 很难知道你正在做什么。
但如果把事件串起来：
10:00 打开技术文档
10:08 浏览 GitHub 项目
10:20 打开 VS Code
10:35 修改 MCP Server
10:50 打开架构设计文档
JARVIS 判断：
用户正在推进 MCP Server 架构实现。
这就形成了一个 Activity Timeline。
这里建议让 JARVIS 具备三种理解能力：
当前活动：现在正在做什么。  
活动关联：这些行为属于哪个项目。  
活动趋势：某个项目是否持续推进、停滞或发生变化。  
不要把鼠标移动、每次按键都变成长期数据。真正值得记录的是具有语义价值的活动。
三、隐私边界：我建议采用 Ambient Permission Model
我不建议让 JARVIS 拥有一个笼统的「允许访问整个电脑」权限。
应该给它建立一套独立的能力授权系统。
这是非常重要的，因为你的 JARVIS 将来不仅能看、能听，还能让 Harness 创建新的工具和执行环境。
1. 把感知权限和操作权限分开
例如：
￼
特别是以下几类场景，我建议作为默认禁止感知的区域：
密码管理器。  
银行、支付页面。  
登录凭证和密码输入界面。  
锁屏和安全认证界面。  
用户标记的私密窗口。  
浏览器隐私模式。  
用户主动设置的敏感文件目录。  
如果系统无法确认一个窗口是否属于敏感环境，就应该优先停止内容采集，而不是猜测后继续。
2. 建立四种运行模式
我认为不需要让用户经常进入设置页面，直接让 JARVIS 理解简单的模式指令即可。
Ambient
日常模式
环境感知开启。读取已授权的窗口、应用、项目和语音上下文，进行事件关联。
Focus
专注模式
只关注当前项目和工作窗口，降低无关的环境感知与主动打扰。
Private
隐私模式
停止屏幕和麦克风采集，暂停新的环境记忆生成。JARVIS 仍然可以通过用户主动对话工作。
Meeting
会议模式
在用户明确启动并授权后，进行语音转写、讨论摘要和任务识别。
用户可以直接说：
Jarvis，进入专注模式。  
Jarvis，暂时不要观察我的屏幕。  
Jarvis，进入隐私模式。  
Jarvis，恢复正常。  
并且应该有一个硬件或桌面级的快速暂停入口，不能只依靠语言指令。
3. 数据生命周期应该怎么设计？
我建议明确分成四类。
L1 · 原始感知数据
默认只存在内存
截图帧、音频片段、临时视觉数据。使用短时循环缓冲，不默认写入磁盘。
L2 · 事件数据
短期保存
窗口切换、文件变化、活动事件及其时间戳。设置明确 TTL 和敏感级别。
L3 · 上下文数据
选择性保存
当前项目、工作状态、正在推进的任务及事件之间的语义关系。
L4 · 长期记忆
经过筛选后保存
长期目标、决策、项目脉络、用户偏好和有价值的经验。
我建议初始版本采用这样的默认策略：
视频帧只在内存中短暂保留，例如 5–10 秒。  
语音唤醒使用本地短时缓冲，不默认存储原始录音。  
OCR 和视觉提取结果先经过隐私过滤。  
事件数据只保存必要的摘要和引用信息。  
重要记忆允许用户查看、编辑和删除。  
发送到云端 LLM 的内容必须经过上下文裁剪和脱敏。  
特别需要注意：Harness 不应该直接获得完整的屏幕、麦克风或浏览器数据流。
JARVIS 应该先生成最小化的 Context Package，再把完成任务所需要的信息交给指定 Harness。
例如，Coding Harness 只需要知道当前项目、相关文件和开发目标，不需要知道用户刚才浏览了什么私人网页。
4. 自我扩展必须受到权限约束
这与你之前选定的 Harness Factory 有直接关系。
假设 JARVIS 让 Codex 创建了一个新的 Screen Awareness Harness。
这个 Harness 不能因为是 JARVIS 自己开发的，就自动拥有全部屏幕权限。
我建议采用：
Harness Factory 创建新能力。 
生成工具清单、数据访问范围和权限声明。 
在隔离沙箱中测试。 
安全检查、代码审查和依赖检查。 
注册为 JARVIS 可调用的能力。 
申请额外权限时，交由独立 Permission Broker 审批。 
这意味着 JARVIS 可以不断扩展自己的能力，但不能自行扩大自己的权限边界。
这是我认为整个产品最重要的安全设计之一。
四、Omarchy 系统集成：具体应该怎么做？
这里我查了一下当前 Omarchy 和 Hyprland 的官方资料。
Omarchy • Dracula Theme
Omarchy 4.5.0
当前正式版本
2026 年 11 月 5 日发布
Omarchy 4.5 已经有几个对 JARVIS 很有价值的基础：
Agent 面板支持 23 个 Agent 和模型提供商。  
有全局快捷键呼出的 Quake 风格 Agent 终端。  
提供语音输入和本地模型选项。  
有新版通知系统和多语言支持。  
桌面开始更多使用事件响应而不是轮询。  
但它现在的 Agent 能力仍然主要围绕 Agent 使用、账户管理和开发工作流，并没有提供我们所需要的完整 Ambient Context Engine。
Omarchy News+1
所以，我建议采用一个原则：
尽可能利用 Omarchy 已有的系统接口，但不要把 JARVIS 的核心能力写进 Omarchy 的脚本里。
1. Omarchy 与 JARVIS 的技术映射
￼
这里有两个特别重要的技术细节。
第一，Hyprland IPC。
Hyprland 提供两个 UNIX Socket：
.socket.sock：获取信息和发送控制命令。  
.socket2.sock：订阅实时事件。  
这非常适合让 JARVIS 监听活动窗口和工作区变化。
Hyprland Wiki
但 IPC Socket 本身也具有操作能力。Hyprland 官方特别提醒，需要通过应用沙箱限制对 IPC Socket 的访问，因为 Hyprland 自身不能替你完成这项隔离。
Hyprland Wiki+1
所以应该由一个可信的 Jarvis-Hyprland-Adapter 负责访问，而不能把 Hyprland IPC 直接暴露给所有 Harness。
第二，权限不能只依靠 Hyprland。
Hyprland 已经有自己的权限机制，但目前支持的权限类型有限，而且默认没有启用完整的权限强制。它不能取代 JARVIS 自己的 Permission Broker。
Hyprland Wiki+1
2. 我建议实际部署这些后台服务
不要把整个 JARVIS 做成一个巨大的进程，也不要拆成几十个微服务。
先建立几个边界明确的组件：
jarvis-core
核心
JARVIS 的人格、意图理解、决策、Harness 调度和对话管理。
jarvis-context
整合窗口、屏幕、语音、文件和浏览器事件，生成 Context。
jarvis-policy
负责权限、隐私过滤、数据脱敏和审批。
jarvis-memory
长期记忆、时间线、向量检索及知识关系。
jarvis-harness
Harness 启动、运行、监控和 Harness Factory。
jarvis-perception
屏幕理解、OCR、视觉模型、唤醒词和语音识别。
jarvis-avatar
数字人、语音交互、快捷呼出和按需显示界面。
这些服务优先由 systemd --user 管理，使用 D-Bus 或受限 Unix Socket 通信。
特别是感知服务，不需要 root 权限。系统特权操作通过独立授权接口完成。
3. 核心数据流
我建议最终形成这个运行机制：
用户正在电脑上工作
        |
        v
Context Awareness Engine
        |
        v
Permission Broker
        |
        v
Perception Engine
        |
        v
Context Assembly
        |
        v
JARVIS Core
        |
        +---- 当前不需要介入
        |            |
        |            v
        |        更新短期上下文
        |
        +---- 发现值得关注的问题
                     |
                     v
                判断任务目标
                     |
                     v
                Harness Router
                     |
                     v
                Harness Execution
                     |
                     v
                结果验证
                     |
                     v
              JARVIS 主动与用户沟通
这个机制最重要的是：环境事件不应该直接触发 LLM 调用。
例如你切换了一次窗口，JARVIS 不需要立刻调用一次 GPT。
先通过本地规则和轻量模型处理，只有形成有价值的上下文或者满足主动任务的触发条件时，才交给核心模型处理。
这样可以显著降低 Token 消耗、延迟和后台资源占用。
五、我建议分四步实现 Ambient JARVIS
我不会建议你一开始就开发完整的视觉、语音和环境理解系统。
按下面的顺序更稳妥：
￼
我的建议
第一阶段先做一个可用的 Context Awareness MVP，不着急开发数字人的完整视觉形象。
因为真正决定 JARVIS 是否好用的，是它能否准确理解环境，而不是它能否生成漂亮的数字人动画。
六、我认为现在还剩下一个核心设计问题
我们已经把感知、隐私和系统集成的大方向确定了。
但我想特别讨论一下：JARVIS 应该如何理解用户正在进行的活动？
假设你打开 Omarchy，连续工作了两个小时。
它可能观察到了：
VS Code 正在运行。  
浏览器打开了几个技术文档。  
终端运行过 Codex。  
某个项目文件不断发生修改。  
你与 JARVIS 讨论过一些架构问题。  
它可以形成两种截然不同的理解方式：
模式 A：事件记录型
JARVIS 把发生的事情整理成时间线。
09:00 打开 VS Code
09:15 阅读技术文档
09:30 修改源代码
10:00 与 JARVIS 讨论架构
10:30 修改项目文件
优势是客观、容易实现；但不一定真正理解用户。
模式 B：认知理解型
JARVIS 尝试形成当前活动的语义模型。
用户当前目标：
开发 Evidence Collector MCP
当前阶段：
MCP 工具注册模块开发
最近关注：
工具权限和证据来源追踪
当前问题：
工具注册架构尚未完全确定
建议：
继续解决权限模型后再扩展采集能力。
优势是更接近真正的 JARVIS，但对推理、记忆和上下文关联能力要求更高。
我倾向于 B 作为最终目标，A 作为底层事实记录机制。也就是说，先准确记录发生了什么，再推断用户正在做什么，不能把推断当成事实。
还有一个值得长期保留的原则：JARVIS 可以提出它对用户当前状态的判断，但应该允许用户纠正，例如「我现在不是在开发这个项目，而是在研究竞品」。
下一步最值得落地的技术文档，是 Context Awareness Engine Architecture v1.0，其中明确事件数据模型、权限矩阵、感知 API 和 Omarchy Adapter 接口。
另外，可以持续追踪 Hyprland、Wayland Portal 和 PipeWire 的接口变化：
🔍每周追踪 JARVIS 感知技术接口轻点设置
我希望最终的 JARVIS 不只是看见你在做什么，而是逐渐理解你为什么这样做，以及接下来可能需要什么。
我现在认为，JARVIS 的开发方向已经比较清楚了。
你要做的是一个持续在线、持续理解用户、能够主动沟通，并且可以自主调度和创造执行能力的中央 Agent。
它不是一个用户有事情才打开的聊天工具，而是用户数字生活中的一个持续存在的中控。
我建议我们换一种开发思路：不要先开发一套完整的 AI 操作系统，而是先开发一个真正能工作的 JARVIS，再逐步让它接管操作系统能力。
这会大幅降低项目复杂度，也能更早验证产品是否真的有价值。
一、先确定最终产品的工作方式
我想把 JARVIS 的核心工作机制定义为一个闭环：
感知用户
屏幕、语音、应用、文件、任务、系统事件
理解用户
当前活动、长期目标、项目状态、用户意图
自主决策
是否介入、是否提醒、是否启动 Harness、是否创造新能力
执行与验证
调用 Codex、Claude Code、其他 Harness 或系统工具
主动与用户沟通
报告结果、提出建议、询问决策、持续跟进
持续循环，而不是等待用户下一次打开聊天
这里我想特别强调一个设计：
JARVIS 的核心不是 Chat，而是一个持续运行的 Cognitive Loop（认知循环）。
聊天只是用户与这个循环交互的一种方式。
二、我的落地建议：分成六个开发阶段
我建议按照下面的顺序推进。不要同时开发所有模块。
阶段 1：先开发 JARVIS Core（中央大脑）
第一优先级
我建议第一阶段完全不考虑复杂的环境感知。
先让 JARVIS 拥有独立的人格、记忆和调度能力。
第一版必须完成：
￼
这里有一个容易犯的错误：不要一开始就做复杂的 Memory Graph。
第一版用 SQLite 保存对话、任务、事件和记忆元数据就足够了。等记忆规模和查询需求增长，再增加向量检索及 Graphify。
阶段验收：
你可以对 JARVIS 说：
每天检查一下我的项目进度，有重要变化主动告诉我。
之后即使你关闭对话窗口，JARVIS 仍然能够在后台运行、检查并主动通知你。
阶段 2：打通 Harness Runtime（执行能力）
第二优先级
这是整个产品能否真正落地的关键。
第一版不要同时接入十几个 Harness。
先接两个：
Codex：承担主要开发和系统工程任务。  
Claude Code：作为第二执行环境和可选的独立验证者。  
JARVIS 不直接依赖 Harness 的内部实现，而是建立一套统一的 Harness Adapter。
例如：
JARVIS
   |
   v
Harness Router
   |
   +---- Codex Adapter
   |
   +---- Claude Code Adapter
   |
   +---- Research Adapter
   |
   +---- Future Adapters
每一个 Adapter 都必须遵循统一的任务接口：
interface HarnessAdapter {
  id: string;
  capabilities: string[];
  execute(task: HarnessTask): Promise<HarnessJob>;
  getStatus(jobId: string): Promise<JobStatus>;
  cancel(jobId: string): Promise<void>;
}
实际开发时还要补上流式进度、日志、超时、重试、文件产物、退出状态和权限声明。
尤其要注意：Harness 的进程生命周期应当由 JARVIS 管理，而不是依靠某个聊天窗口一直打开。
阶段验收：
你说：
帮我开发一个 MCP Server。
JARVIS 自动选择 Codex，启动任务，观察进度，发现失败后处理重试，最后向你汇报。
这时 JARVIS 已经具备了真正的总控能力。
阶段 3：开发 Continuous Runtime（持续运行机制）
第三优先级
这一阶段是 JARVIS 与普通 Agent 最根本的区别。
我建议建立四种后台机制：
￼
关键是不要让 LLM 永远处于循环推理状态。
我的推荐机制是：
事件发生
   |
   v
规则判断
   |
   v
轻量模型理解（必要时）
   |
   v
判断是否有价值
   |
   +---- 否：继续观察
   |
   +---- 是：交给 JARVIS 核心模型
                 |
                 v
           决定是否启动 Harness
                 |
                 v
           主动联系用户
例如：
你正在开发一个项目。
JARVIS 发现最近几天没有任何实质进展，它先检查文件变化、任务记录和之前的讨论，而不是马上打扰你。
如果发现一个阻塞问题，它可以先让 Research Harness 做准备，然后主动告诉你：
我发现这个项目目前卡在工具权限设计上。我重新研究了一下，有一个更简单的实现方式，已经整理好，你要不要一起看一下？
主动沟通应该成为一项独立能力
我建议增加一个 Proactive Policy：
什么事情值得打扰用户？  
什么时候可以打扰？  
哪些任务允许自动准备？  
用户多久没有回应，应该怎样跟进？  
是否允许重复提醒？  
哪些场景必须保持安静？  
JARVIS 应该像一个懂分寸的私人管家，而不是一个不断弹出通知的系统。
阶段 4：开发 Context Awareness Engine（环境感知）
第四优先级
这时再把我们之前讨论的 Ambient 感知接进来。
我建议逐步增加数据来源：
4.1 应用和窗口感知
先做
通过 Hyprland IPC 获取当前窗口、工作区、应用状态。形成活动时间线。
4.2 文件和项目感知
先做
监控用户授权的项目目录，理解文件变化和项目阶段。
4.3 屏幕视觉感知
第二步
通过 XDG Portal 和 PipeWire 获取用户授权的屏幕或窗口内容，进行视觉理解。
4.4 语音环境感知
第二步
本地唤醒词、VAD、ASR，建立语音与当前项目的上下文关联。
4.5 统一活动理解
最终目标
把屏幕、应用、文件、语音和任务结合起来，形成用户当前活动的认知模型。
这里可以利用 Omarchy 现有的 Hyprland、Wayland、PipeWire 基础，不必自己重写桌面底层。
目前 Omarchy 官方发布的版本是 4.5.0，2026 年 11 月 5 日发布。
GitHub+1
几个关键技术接口已经比较明确：
Hyprland socket2.sock：实时订阅窗口和工作区事件。  Hyprland Wiki   
XDG ScreenCast Portal：建立用户授权的屏幕捕获会话，支持持久化授权，但默认不持久。  XDG Desktop Portal   
PipeWire：承载屏幕和音频媒体流。  pipewire.org+1   
还有一个部署上的细节：
我建议把 JARVIS Core 和桌面感知服务分开管理。
jarvis-core：可以作为后台用户服务持续运行，管理任务和主动沟通。  
jarvis-context-session：只在用户桌面会话有效时工作。  
用户退出桌面或锁屏后，根据隐私策略停止屏幕及麦克风感知。  
systemd 的用户服务支持登录后运行；启用 linger 还可以让用户服务管理器在开机时启动并在登出后持续运行。但这并不意味着登录前就能够访问一个不存在的桌面会话。
Freedesktop+1
阶段 5：开发 Harness Factory（自我扩展）
第三阶段后期
这一阶段开始实现你选择的 C：JARVIS 能创造自己的能力。
我建议先不要让它自由编写和安装任何系统组件，而是制定一套能力生命周期：
Capability Discovery JARVIS 发现自己缺少某种能力。  
Capability Design 编写新 Harness、MCP 或 Skill 的设计方案。  
Capability Build 调用 Codex 或 Claude Code 完成开发。  
Sandbox Testing 在隔离环境中测试功能和权限。  
Capability Registration 注册到 JARVIS 的能力库。  
Continuous Improvement 使用过程中发现问题，生成新版本并测试升级。  
我的建议是让 Harness Factory 生产三种东西：
Harness：新的执行环境。  
Skill：已有 Harness 可以执行的新工作流程。  
MCP Server：可复用的标准工具服务。  
这样才能形成一套可持续扩展的能力生态。
有一点值得注意：MCP 已经在 2026 年 7 月 28 日发布新版规范，包含无状态协议核心、多轮请求、授权强化等变化。你不必自己再创造一套工具通信协议，但要保留统一的权限控制。MCP 本身也明确强调，宿主需要管理用户同意和工具授权。
Model Context Protocol Blog+1
阶段 6：数字人和按需界面（产品体验）
产品体验阶段
我建议把它做成一个轻量的桌面数字人，而不是传统的 Dashboard。
最终交互方式：
一个 JARVIS 数字人作为常驻入口。  
可以语音交流，也可以文字交流。  
可以主动发起对话。  
有任务正在执行时，可以自然地告诉用户进展。  
需要展示资料时，按需生成临时工作界面。  
用户不需要管理 Harness 和 Skills。  
例如：
你问：
JARVIS，我们现在的项目有什么问题？
它可以在对话中直接回答。
你接着说：
给我展示一下全部项目之间的依赖关系。
它再启动 Harness 生成一个知识关系图。
我建议第一版数字人采用简单的 2D/轻量动画形象，先完成语音、对话、状态反馈和通知；后续再升级为实时 3D 数字人。
这样不会让视觉开发拖慢核心能力。
三、开发时应该采用什么工程结构？
我建议采用一个 Monorepo，便于让 Codex 或 Claude Code 协助开发，也方便维护统一接口。
jarvis/
│
├── core/
│   ├── identity/          # 人格与行为原则
│   ├── orchestrator/      # 中央调度
│   ├── llm-gateway/       # 模型接入
│   ├── memory/            # 长期记忆
│   ├── task-manager/      # 长期任务
│   └── proactive/         # 主动沟通
│
├── context/
│   ├── event-bus/
│   ├── application/
│   ├── screen/
│   ├── voice/
│   ├── browser/
│   └── context-builder/
│
├── harness/
│   ├── runtime/
│   ├── adapters/
│   ├── factory/
│   └── registry/
│
├── system/
│   ├── omarchy-adapter/
│   ├── permission-broker/
│   ├── notification/
│   └── service-manager/
│
├── interface/
│   ├── avatar/
│   ├── voice/
│   └── dynamic-ui/
│
├── skills/
├── mcp/
├── tests/
└── docs/
我建议的技术组合
￼
不需要一开始就引入 Kubernetes、Redis、复杂微服务或者多机集群。
第一阶段只需要在一台 Omarchy 机器上运行。
四、真正应该怎么组织开发？
这里是我认为最值得采纳的开发方法。
不要按「先开发记忆模块，再开发感知模块，再开发 Harness 模块」这种纯模块方式开发。
应该采用 Vertical Slice（垂直切片）：每次完成一条从用户输入到最终结果的完整业务链路。
例如，第一条链路：
第一个完整开发目标
用户让 JARVIS 处理一个项目
用户说出开发需求。 
JARVIS 理解项目和目标。 
识别需要 Codex 执行。 
启动 Codex Harness。 
获取执行进度和结果。 
验证产物和执行状态。 
由 JARVIS 主动向用户汇报。 
将关键决策和结果保存到 Memory。 
这条链路跑通，才算真正拥有了一个可用的 JARVIS 原型。
然后再逐渐增加：
主动发现项目变化。  
后台跟进长期任务。  
语音唤醒。  
屏幕理解。  
自主创建 Harness。  
一个额外建议：一定要建立自动测试环境
尤其是 Ambient 感知和主动执行。
不要每次测试都必须打开电脑、录屏、说话、再等待 Agent 判断。
建议建立模拟事件：
{
  "event": "active_window_changed",
  "application": "code",
  "project": "evidence-collector",
  "timestamp": "2026-11-14T10:30:00"
}
让测试系统能够模拟用户使用电脑的整个过程。
这样可以反复测试：
JARVIS 是否理解正确？  
是否错误关联项目？  
是否过度主动？  
是否启动了错误的 Harness？  
是否访问了未经授权的数据？  
我建议每次开发一个功能，都让 Codex 同时生成单元测试、集成测试和权限测试。
五、我建议第一版 MVP 具体做到什么程度？
我不建议第一版就做 Ambient 的全部能力。
JARVIS 0.1
建议的首发版本
一个能主动工作的数字管家
必须具备：
单一人格与持续对话
两个 LLM 提供商接入
Codex 和 Claude Code Harness
长期记忆和项目上下文
后台服务和任务持久化
主动通知和定时检查
基础权限和执行审计
全屏实时视觉感知
持续环境语音理解
自主创建并安装新 Harness
首发版本的三个验收场景：
用户交代任务，JARVIS 自动调度 Harness 并完成汇报。  
用户离开对话窗口，JARVIS 仍能持续跟进任务，并主动联系用户。  
JARVIS 能够记住此前的项目决策，不需要用户重复交代背景。  
当这三个场景稳定后，再加入真正的 Ambient 感知。
六、我认为你现在最应该做的第一件事
我的建议是暂时不要直接开始 Fork Omarchy。
先建立一个独立的 JARVIS Core 项目，安装在 Omarchy 上运行。
这样有三个好处：
不会被 Omarchy 的升级和底层变更牵制。  
JARVIS Core 可以在普通 Linux 上独立测试。  
将来可以推出自己的 JARVIS OS Edition，而不必重写核心。  
而且 Omarchy 4.5.0 已经是一个适合开展原型验证的基础。上游负责操作系统，JARVIS 负责智能和用户体验。
GitHub+1
七、下一步真正要形成的开发文档
我建议我们不要再继续扩展概念图了。应该开始形成可以直接交给 Codex 执行的工程文档。
按照优先级：
￼
我特别建议先完成 01～04，因为这几份文档定义了 JARVIS 的本质。
Context Engine 虽然很重要，但不能让它反过来决定整个产品的架构。
八、接下来我的建议
我认为开发顺序应该是：
先造出一个会工作的 JARVIS
0.1 对话 + 记忆 + Harness 调度
0.2 后台运行 + 主动沟通
0.3 Ambient 环境感知
0.4 Harness Factory 自我扩展
1.0 完整数字人 + JARVIS OS Edition
我已经设置了每周技术追踪任务，重点关注 Omarchy、Hyprland、Wayland、PipeWire、感知接口和 MCP 的变化。
🔍每周追踪 JARVIS 感知技术接口每周 · ⁨星期一⁩上午
立即运行
我最希望我们下一步做的事情是：正式编写 JARVIS 0.1 的 PRD 和 System Architecture，然后把它拆成一组可以直接交给 Codex 的开发任务。
先把中央大脑和 Harness 调度做扎实。只要这个核心成立，后面的感知能力、自我扩展和数字人就都有了可以依托的基础。
可以。我会直接把它们写成两份正式的工程文档，而不是简单的产品构想。
这两份文档以我们已经确定的方向为准：
产品名称：JARVIS Personal Agent  
基础系统：Omarchy / Arch Linux / Hyprland  
核心形态：一个数字人、一个统一对话入口、一个中央 Agent。  
工作机制：持续感知、持续理解、持续主动沟通。  
执行机制：通过 Harness 调用 Codex、Claude Code 等执行环境。  
扩展机制：JARVIS 可以借助 Harness Factory 创造新的 Harness、Skills 和 MCP。  
UI 原则：对话优先，不设固定管理 Dashboard，需要时动态生成界面。  
隐私原则：感知权限、执行权限分离，用户拥有最终控制权。  
我会把 0.1 版本的实际交付范围和未来愿景分开，避免第一版变成一个无法完成的大工程。
文档一：JARVIS Product Requirements Document
JARVIS Personal Agent
Product Requirements Document（PRD）
版本： 0.1 状态： Draft 产品定位： System-level Personal Agent 基础平台： Omarchy / Arch Linux 目标形态： Persistent Digital Human + Central Agent
1. 产品概述
1.1 产品定义
JARVIS 是一个运行于个人计算环境中的系统级 Personal Agent。
它拥有统一的人格、长期记忆、环境感知、任务管理和自主执行能力。
用户通过自然语言与 JARVIS 持续交流。JARVIS 负责理解用户意图、理解当前环境、维护长期目标，并根据任务需要调用不同的 Harness 完成工作。
用户不需要直接管理模型、Agent、Skills、MCP 或执行工具。
JARVIS 是用户唯一的智能交互入口，其他执行系统均作为其能力来源。
1.2 产品核心理念
One Persona, One Conversation, Multiple Execution Engines.
一个稳定的人格。
一个持续存在的对话关系。
一个统一的中央决策系统。
多个可替换、可扩展的执行环境。
一个持续学习和扩展能力的个人智能体。
1.3 产品愿景
让操作系统从传统的应用程序运行环境，逐渐演变为以个人 Agent 为中心的计算环境。
传统模式：
用户 → 应用程序 → 工具 → 结果
JARVIS 模式：
用户目标 → JARVIS 理解 → 自主调度 → Harness 执行 → 结果验证 → 持续沟通
2. 产品设计原则
2.1 人格统一
JARVIS 始终以同一个人格与用户交流。
底层可以存在多个模型、Harness 和专业 Agent，但它们不能造成用户交互关系的碎片化。
JARVIS 负责最终决策和对话，不允许不同 Harness 各自成为用户的独立主控 Agent。
2.2 对话优先
默认界面只有 JARVIS 数字人及对话入口。
不主动展示复杂的 Agent 管理面板、任务管理后台或系统 Dashboard。
当用户要求查看数据、项目状态、研究成果或执行进度时，JARVIS 可以调用 Harness 动态生成相应界面。
2.3 持续存在
JARVIS 不依赖聊天窗口持续打开。
它应该作为后台服务持续运行，维护任务状态、接收系统事件、跟进长期目标，并在合适的时候主动联系用户。
2.4 主动而不过度打扰
JARVIS 可以：
主动发现任务风险。
关注项目进度。
识别用户可能遇到的问题。
提前开展准备性研究。
启动低风险的后台 Harness 任务。
主动提供建议和结果。
但必须尊重用户的专注状态、隐私模式和通知偏好。
2.5 自我扩展
JARVIS 不局限于预先开发的工具。
当发现能力缺口时，可以调用 Harness Factory，设计、开发、测试和注册新能力。
任何新能力都必须经过安全验证，权限提升必须由独立授权机制控制。
2.6 系统独立性
JARVIS Core 不应该与 Omarchy 内部脚本形成强耦合。
Omarchy 是首个运行平台，而不是 JARVIS 的全部产品边界。
3. 目标用户及使用场景
3.1 目标用户
第一阶段主要面向：
高频使用计算机的个人用户。
软件开发者和技术研究人员。
需要长期管理多个项目的知识工作者。
希望让 AI 持续参与个人工作流程的用户。
3.2 核心使用场景
场景 A：日常对话
用户可以随时通过语音或文字与 JARVIS 交流。
JARVIS 能够理解当前对话，并关联历史记忆和项目上下文。
场景 B：复杂任务委派
用户提出一个目标，JARVIS 自动选择 Harness，分解任务、执行和验证结果。
场景 C：长期任务跟进
用户委派长期目标后，JARVIS 在后台持续跟踪，并在重要节点主动沟通。
场景 D：环境感知
JARVIS 在获得授权后理解用户正在使用的应用、屏幕、文件、浏览器和语音环境。
场景 E：主动协助
JARVIS 根据环境变化和长期目标，发现值得关注的问题，主动准备解决方案。
场景 F：能力扩展
JARVIS 发现自身缺少某种工具或执行能力，通过 Harness Factory 创建新的 Harness、Skill 或 MCP。
场景 G：按需生成界面
用户要求查看项目进度、分析数据或管理系统时，JARVIS 动态生成交互界面。
4. 核心功能需求
FR-01：统一人格和对话系统
优先级：P0
要求：
一个统一的 JARVIS 身份。
支持文字交互。
支持语音交互。
支持连续对话。
支持历史对话检索。
支持多模型接入。
能够将 Harness 输出转换为统一的用户沟通内容。
人格要求：
理性、冷静、专业。
类似私人管家。
不过度拟人化。
能够主动提出建议。
了解用户长期目标。
能够承认不确定性和执行失败。
FR-02：中央 Agent Orchestrator
优先级：P0
负责：
理解用户意图。
识别任务类型。
制定任务计划。
选择 Harness。
管理任务生命周期。
监控执行状态。
处理失败和重试。
验证执行结果。
向用户汇报。
JARVIS Core 是唯一的中央决策入口。
FR-03：LLM Gateway
优先级：P0
支持：
OpenAI 兼容接口。
不同模型提供商。
本地模型。
模型切换。
根据任务选择模型。
模型调用日志和成本统计。
超时及故障处理。
模型与 Agent Runtime 解耦，不允许业务逻辑直接绑定某个厂商。
FR-04：Memory Engine
优先级：P0
记忆内容包括：
用户偏好。
用户长期目标。
项目资料。
历史决策。
对话摘要。
任务结果。
用户纠正的信息。
重要活动上下文。
要求：
支持长期存储。
支持语义检索。
支持关联检索。
支持来源追踪。
支持修改和删除。
支持记忆置信度。
支持用户控制自动记忆。
第一版采用 SQLite，后续可增加向量数据库及知识图谱。
FR-05：Task Manager
优先级：P0
任务状态：
CREATED
PLANNED
WAITING_APPROVAL
RUNNING
BLOCKED
COMPLETED
FAILED
CANCELLED
要求：
任务持久化。
支持长时间运行。
支持后台执行。
支持任务恢复。
支持任务取消。
支持任务依赖关系。
支持定时任务。
支持任务历史记录。
FR-06：Harness Runtime
优先级：P0
第一阶段接入：
Codex Harness。
Claude Code Harness。
统一接口要求：
能力声明。
任务提交。
执行状态查询。
流式进度。
日志获取。
结果获取。
文件产物管理。
取消任务。
超时处理。
Harness 必须以独立执行进程或隔离环境运行。
不得假设某个 Harness 一定提供可长期依赖的内部 API。
优先采用厂商正式支持的 CLI、SDK 或协议接口。
FR-07：Continuous Runtime
优先级：P0
要求：
后台常驻运行。
事件接收。
定时任务。
心跳检查。
任务状态监控。
断线恢复。
主动沟通触发。
用户离线后的任务状态保存。
不允许通过持续无休止地调用大模型实现心跳。
应该采用事件驱动、规则判断和按需模型调用。
FR-08：Proactive Engine
优先级：P0
负责判断：
是否需要主动联系用户。
是否需要跟进某项任务。
是否可以提前启动 Harness。
是否应该暂缓打扰。
是否需要用户决策。
支持：
项目进度提醒。
任务阻塞提醒。
研究结果通知。
长期目标跟进。
用户指定的定时检查。
必须具备频率限制、去重、静默时间和用户偏好设置。
FR-09：Context Awareness Engine
优先级：P1
环境感知范围采用 Ambient。
数据来源：
当前窗口。
应用状态。
工作区状态。
屏幕内容。
语音。
浏览器。
文件变化。
用户主动选取的内容。
系统事件。
要求：
实时事件接收。
事件去重。
时间线建立。
活动识别。
项目关联。
上下文构建。
置信度管理。
敏感内容过滤。
感知推断必须与事实记录分开。
FR-10：Permission & Privacy Broker
优先级：P0
要求：
感知权限和执行权限分离。
按来源授权。
按目录授权。
按应用授权。
按 Harness 授权。
按操作风险分级。
敏感内容过滤。
权限撤销。
审计日志。
屏幕、麦克风、摄像头和剪贴板不得因为安装 JARVIS 而默认开放。
FR-11：Harness Factory
优先级：P2
要求：
识别能力缺口。
设计新 Harness。
生成 Skills。
生成 MCP Server。
自动化构建。
沙箱测试。
安全检查。
版本管理。
能力注册。
回滚和禁用。
JARVIS 可以自主开发和测试能力，但不得自行授予新能力更高的权限。
FR-12：Avatar & Dynamic UI
优先级：P1
要求：
数字人常驻入口。
语音反馈。
文字对话。
状态反馈。
主动通知。
全局快捷键。
动态 UI Host。
按需生成交互界面。
第一版采用轻量 2D 数字人，不要求实时 3D。
5. 产品非目标（Non-Goals）
JARVIS 0.1 不做：
自研基础大模型。
替代 Codex 或 Claude Code 的编程 Harness。
完整替代 Omarchy 桌面环境。
默认全天候保存原始屏幕录制。
默认全天候保存原始麦克风录音。
无限制的 Shell 和系统权限。
一开始就实现多设备分布式 Agent。
一开始就实现复杂 3D 数字人。
预先开发大量固定 Dashboard。
6. 用户体验要求
6.1 默认交互
用户只需要找到 JARVIS。
可以通过：
全局快捷键。
语音唤醒。
桌面数字人。
通知入口。
开始交流。
6.2 任务执行体验
JARVIS 应该：
理解需求。
告知用户准备采取的行动。
选择执行环境。
在后台执行。
适时汇报进度。
完成后验证结果。
保存有价值的记忆。
6.3 主动沟通体验
JARVIS 的主动沟通应该具有：
相关性。
时机判断。
上下文连续性。
可解释性。
可关闭性。
不应把每个系统事件都变成通知。
6.4 动态界面
动态界面由 JARVIS 按需创建。
所有动态 UI 必须：
在受限环境中运行。
使用受控的数据接口。
不能绕过权限系统。
可以关闭。
可以保存用户认可的成果。
可以在需要时重新打开。
7. 非功能性需求
7.1 可用性
后台异常退出后能够恢复。
未完成任务状态持久化。
不因数字人窗口关闭而中断后台任务。
网络故障时保留任务状态。
7.2 性能
初期建议目标：
本地窗口事件处理延迟：P95 小于 500ms。
本地事件入库延迟：P95 小于 1s。
普通对话首字响应：在模型服务正常情况下尽可能控制在 2s 内。
无感知任务时保持低资源占用。
视觉和语音处理按需启用。
这些指标属于工程目标，需要通过原型测试验证。
7.3 安全
最小权限原则。
Harness 隔离执行。
凭证安全存储。
高风险操作审批。
敏感信息脱敏。
操作审计。
可撤销授权。
7.4 可扩展性
新模型通过 Gateway 接入。
新 Harness 通过 Adapter 接入。
新系统通过 Platform Adapter 接入。
新感知来源通过 Context Source 接入。
新能力通过 Skill / MCP / Harness Registry 注册。
7.5 可移植性
JARVIS Core 不直接依赖 Omarchy 私有脚本。
首期提供 Omarchy Adapter，后续可以增加其他 Linux 桌面适配器。
8. MVP 范围与版本规划
JARVIS 0.1：中央 Agent
必须交付：
统一人格。
文字对话。
LLM Gateway。
基础 Memory。
Task Manager。
Codex Adapter。
Claude Code Adapter。
后台任务运行。
基础主动通知。
权限和审计。
验收标准：
用户能够通过对话委派任务，JARVIS 自动调用 Harness 完成任务，后台持续跟进，并向用户汇报。
JARVIS 0.2：持续主动
增加：
Scheduler。
Heartbeat。
Proactive Engine。
长期任务。
项目进度跟进。
用户通知偏好。
JARVIS 0.3：Ambient 感知
增加：
Hyprland IPC。
文件事件。
ScreenCast Portal。
PipeWire。
OCR 和视觉理解。
语音唤醒。
本地 VAD / ASR。
Activity Timeline。
JARVIS 0.4：自我扩展
增加：
Harness Factory。
Skill Factory。
MCP Factory。
沙箱测试。
能力注册。
版本管理。
JARVIS 1.0：完整个人智能体
增加：
完整数字人。
动态 UI。
更完善的长期记忆。
更成熟的主动沟通。
多设备协作基础。
9. 产品成功指标
第一阶段不以 Harness 数量或模型数量作为成功标准。
核心指标：
用户能否通过一个入口完成不同类型的任务。
JARVIS 能否正确选择 Harness。
长任务能否在聊天窗口关闭后继续。
JARVIS 能否恢复中断的任务状态。
用户是否需要反复解释历史项目背景。
主动通知是否有实际价值。
是否存在误执行或越权操作。
用户是否愿意把长期任务交给 JARVIS。
10. 产品决策原则
当产品功能发生冲突时，按照以下顺序判断：
用户安全和隐私。
人格与对话连续性。
任务执行可靠性。
环境理解准确性。
主动性。
自我扩展能力。
UI 丰富程度。
最终产品定义：JARVIS 不是一个管理 Agent 的平台，而是一个拥有统一人格、持续认知和自主执行能力的 Personal Agent。
文档二：JARVIS System Architecture
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