# TechMirai AI voice agent FAQ v2 (client `techmirai-ai`)

Source of truth: the edited ODT. Entries are bilingual (EN + JA). The Japanese has **not** had a native-speaker review yet.

Status key: UNCHANGED = identical to the original; CHANGED = edited by Jamal's decisions (15 Nov 2026); NEW = added.

Changes applied:
- V1, V4 (EN): product name "TechMirai AI受付" replaced by "TechMirai AI" for English speech (受付 = reception).
- V3 (JA): removed a cost-saving claim that the English text does not make.
- V5, C3: now offer to take the caller's name; V5 says the caller is hearing a live demo right now.
- V6 (JA): corrected a mistranslation; the product CAN forward calls, but without a hand-over summary.
- V9, V12: describe what the agent actually collects (name, plus the number to call back on).
- V10: states that call forwarding is switched off on this line.
- NEW L1-L3: "Am I speaking to an AI?", "Can you transfer me to a person?", "When will your staff contact me?". Contact hours in L2/L3: weekdays, 9 a.m. to 6 p.m. Japan time (decided by Jamal, 15 Nov 2026).

## A. The voice agent / 音声エージェントについて

### V1 [CHANGED]
- EN question: What is TechMirai AI?
- EN answer: TechMirai AI is an AI phone agent that answers your calls in natural Japanese or English. It handles common questions, takes callback requests and forwards calls to your staff. It is built for call centres and businesses that get more calls than people can answer.
- JA question: TechMirai AI受付とは何ですか？
- JA answer: TechMirai AI受付は、自然な日本語または英語で電話対応を行うAI電話エージェントです。よくある質問への回答、折り返し連絡の受付、スタッフへの転送を行います。コールセンターや、人員体制を超える多数の電話を受ける企業向けに構築されています。

### V2 [UNCHANGED]
- EN question: What can it do on a call?
- EN answer: It greets the caller, answers from your approved information, and takes a message or callback request when it cannot help. It can forward the call to a person during your staff hours. Every call is logged with a status and a short summary.
- JA question: 電話でどのような対応ができますか？
- JA answer: 発信者の挨拶、承認された情報に基づく回答、対応できない場合のメッセージや折り返し希望の受付を行います。スタッフの勤務時間内であれば、担当者への転送も可能です。すべての通話はステータスと簡単な要約とともに記録されます。

### V3 [CHANGED]
- EN question: Who is it for?
- EN answer: Small and mid-size call centres, BPOs and call-heavy businesses such as utilities and chain stores. They have repeat questions, evening peaks and night calls that are costly to staff. Call centres can also offer it to their own clients under their own brand.
- JA question: どのような企業向けですか？
- JA answer: 中小規模のコールセンター、BPO、そしてユーティリティ（公共インフラ）やチェーン店など、電話対応の多い企業向けです。繰り返しの質問、夕方のピーク、夜間の電話など、人員を配置するとコストのかかる電話を抱えている企業に適しています。コールセンターが自社ブランドとしてクライアントに提供することも可能です。

### V4 [CHANGED]
- EN question: How is it different from a phone menu?
- EN answer: A phone menu makes callers press numbers. TechMirai AI lets them speak in their own words and answers from your approved information. When it cannot help, it takes a callback request or forwards the call, so callers are not stuck in a menu.
- JA question: 電話メニュー（IVR）と何が違いますか？
- JA answer: 従来の電話メニューでは発信者に番号入力が求められますが、TechMirai AI受付では発信者が自分の言葉で話すことができ、承認された情報から回答します。対応できない場合は折り返しの受付や転送を行うため、発信者がメニュー内で立ち往生することがありません。

### V5 [CHANGED]
- EN question: Can I see or hear a demo?
- EN answer: Yes. You are hearing a live demo right now, with the same kind of voice agent we build for businesses. We also run live demos on request using a sample business, so you can hear how it speaks and see what staff get afterwards. If you would like a short demo tailored to your own call types, I can take your name and our staff will contact you to arrange it.
- JA question: デモを見る、または聞くことはできますか？
- JA answer: はい。今まさに、お客様向けにご提供している音声エージェントと同じ種類のライブデモをお聞きいただいています。ご要望に応じて、サンプル企業を用いたライブデモも実施しており、実際の音声や、対応後にスタッフが受け取る内容をご確認いただけます。お客様の通話タイプに合わせた短いデモをご希望でしたら、お名前をお伺いし、担当者からご連絡して日程を調整いたします。

### V6 [CHANGED]
- EN question: What can't it do today?
- EN answer: Today it speaks Japanese and English, forwards calls without a summary for the agent, and is not an emergency service. Deeper links to CRM and booking systems are scoped per project. We would rather tell you the limits now than surprise you in a pilot.
- JA question: 現時点でできないことは何ですか？
- JA answer: 現時点では、対応言語は日本語と英語です。通話の転送は可能ですが、担当者向けの引き継ぎ要約はまだ付きません。また、緊急サービスではありません。CRMや予約システムとの高度な連携は、プロジェクトごとに範囲を決めます。パイロット中に驚かせるよりも、事前に制限事項をお伝えしたいと考えています。

## B. In a call centre / コールセンターでの活用

### V7 [UNCHANGED]
- EN question: Can it answer after hours and at peak times?
- EN answer: Yes. It is built to answer at any hour, including nights, weekends and rush-hour peaks, so callers are not left in a queue or at voicemail. How many calls it can take at the same time is agreed per project.
- JA question: 営業時間外やピーク時にも対応できますか？
- JA answer: はい。夜間、週末、ラッシュ時のピークを含め、いつでも対応できるように設計されているため、発信者がキュー（待ち行列）や留守番電話のまま放置されることはありません。同時通話可能な件数はプロジェクトごとに合意の上決定します。

### V8 [UNCHANGED]
- EN question: Which languages does it speak?
- EN answer: Japanese and English today. A caller speaks Japanese by default or asks for English at the start of the call. More languages are planned, and the system is designed so adding one does not mean rebuilding it.
- JA question: 対応している言語は何ですか？
- JA answer: 現在は日本語と英語に対応しています。デフォルトで日本語に対応し、通話開始時に英語をリクエストすることも可能です。今後さらに言語を追加予定であり、言語追加のためにシステムを再構築する必要がない設計になっています。

### V9 [CHANGED]
- EN question: What happens when it can't answer?
- EN answer: It does not guess. It tells the caller it will pass the request to staff, takes their name, confirms the number to call back on, and saves a callback request for your team. If the caller asks for a person, it forwards the call during staff hours.
- JA question: AIが回答できない場合はどうなりますか？
- JA answer: 推測で回答することはありません。スタッフにリクエストを伝える旨を発信者に伝え、お名前と折り返し先のお電話番号を確認して、チーム向けの折り返しリクエストを保存します。発信者が担当者を希望した場合は、スタッフの勤務時間内であれば通話を転送します。

### V10 [CHANGED]
- EN question: Can it transfer to a human agent?
- EN answer: Yes. It can forward the call to a team you choose, during the hours you set. A hand-over summary is not included yet, so the agent may need to ask the caller to repeat the details. On this phone line, call forwarding is switched off, so I cannot connect you to a person now, but I can take your name and our staff will contact you.
- JA question: オペレーター（人間のスタッフ）へ転送できますか？
- JA answer: はい。指定したチームへ、設定した時間内に通話を転送できます。引き継ぎ用の要約機能はまだ含まれていないため、担当者から発信者に詳細を再度お伺いする場合があります。なお、この電話回線では通話転送を無効にしているため、今すぐ担当者におつなぎすることはできませんが、お名前をお伺いして、担当者からご連絡いたします。

### V11 [UNCHANGED]
- EN question: Can call centres resell it under their own brand?
- EN answer: Yes. Our partner model lets a call centre offer AI after-hours and overflow call handling to its own clients under its own brand. You keep the client relationship and we run the technology. Details are agreed in a partner discussion.
- JA question: コールセンターが自社ブランドとして再販できますか？
- JA answer: はい。当社のパートナーモデルにより、コールセンターは営業時間外や溢れ電話（オーバーフロー）の対応を、自社ブランドとしてクライアントに提供できます。クライアントとの関係は御社が維持し、当社は技術面を運営します。詳細はパートナー協議にて決定します。

### V12 [CHANGED]
- EN question: Can it take messages or book callbacks?
- EN answer: Yes. When a caller needs a person, it collects their name, confirms the best number to reach them, and saves a callback request for your staff to follow up. Anything else it collects, such as the reason for the call, is set up for each business. A simple booking step can be added for businesses that take appointments.
- JA question: メッセージの受付や折り返しの予約はできますか？
- JA answer: はい。発信者が担当者を必要とする場合、お名前を伺い、ご連絡先のお電話番号を確認して、スタッフが後からフォローアップできるように折り返しリクエストを保存します。用件など、その他に収集する内容は企業ごとに設定します。予約を受け付ける企業向けに、簡単な予約ステップを追加することも可能です。

### V13 [UNCHANGED]
- EN question: What do we see after each call?
- EN answer: Your staff see a call list with time, duration, status and a short AI summary, plus callback requests to follow up. The status shows whether the AI resolved the call, took a callback, made a booking or could not help.
- JA question: 通話後はどのような情報を確認できますか？
- JA answer: スタッフは、日時、通話時間、ステータス、AIによる簡単な要約が含まれた通話リストと、フォローアップ用の折り返しリクエストを確認できます。ステータスには、AIが解決したか、折り返しを受付したか、予約を行ったか、対応できなかったかが表示されます。

## C. Trust, data and control / 信頼性、データ、および管理

### V14 [UNCHANGED]
- EN question: Will it make up answers?
- EN answer: It is designed not to. It answers from the information you approve, and when it is not sure it says so and offers a callback or a person. During the pilot we test it on your real question types before anything goes live.
- JA question: 勝手に回答を作り出してしまうことはありませんか？
- JA answer: 作り出さないよう設計されています。承認された情報に基づいて回答し、確信のない場合はその旨を伝えた上で、折り返しや担当者への連絡を提案します。パイロット期間中に、実際の質問タイプでテストを行ってから本番稼働させます。

### V15 [UNCHANGED]
- EN question: Is our call data safe?
- EN answer: We treat call data as confidential. Staff see summaries and status, while recordings and transcripts sit in a restricted archive. We do not hold a formal security certification yet and are working toward one. We agree data handling, storage and access in writing before any pilot.
- JA question: 通話データは安全に保護されますか？
- JA answer: 通話データは機密情報として取り扱います。スタッフは要約とステータスを閲覧できますが、録音データや文字起こしはアクセスが制限されたアーカイブに保存されます。現時点で正式なセキュリティ認証は取得しておらず、取得に向けた取り組みを進めています。データの取り扱い、保管、アクセス権については、パイロット開始前に書面で合意します。

### V16 [UNCHANGED]
- EN question: Are calls recorded?
- EN answer: Calls can be recorded for quality review. When recording is on, the AI tells the caller at the start of the call. Which calls are recorded, who can listen and how long recordings are kept is agreed with you before launch.
- JA question: 通話は録音されますか？
- JA answer: 品質管理のために通話を録音することができます。録音が有効な場合、通話開始時にAIが発信者にその旨を伝えます。どの通話を録音するか、誰が聴取できるか、録音データの保存期間は、ローンチ前に事前に合意の上決定します。

### V17 [UNCHANGED]
- EN question: Can it handle urgent or emergency calls?
- EN answer: It is not an emergency service. For urgent situations we agree rules with each client, such as telling the caller to use the official emergency number and forwarding to staff when someone is available. We do not promise automatic emergency escalation.
- JA question: 緊急の電話にも対応できますか？
- JA answer: 緊急サービスではありません。緊急時の状況については、公式の緊急通報用電話番号を利用するよう発信者に案内することや、スタッフが対応可能な場合に転送することなど、クライアントごとにルールを取り決めます。自動的な緊急エスカレーションはお約束していません。

### V18 [UNCHANGED]
- EN question: Can we control what it says?
- EN answer: Yes. Its answers come from an approved answer set for your business: hours, services, common questions and what to do when it cannot help. We set it up with you and update it when your information changes.
- JA question: AIの発言内容を管理・制御できますか？
- JA answer: はい。営業時間、サービス内容、よくある質問、対応できない場合の対処法など、ビジネス向けに承認された回答セットから回答が生成されます。お客様と一緒に設定を行い、情報が変更された際には適宜アップデートします。

## D. Getting started / 利用開始までの流れ

### V19 [UNCHANGED]
- EN question: How does a pilot work?
- EN answer: We start with a short pilot in four steps: validate your call types, measure how the agent performs on them, decide together whether it is worth it, then build the production version. You see results before you commit to a full rollout.
- JA question: パイロット運用はどのように進みますか？
- JA answer: 以下の4つのステップによる短いパイロットから開始します：通話タイプの検証、エージェントのパフォーマンス測定、導入メリットの共同評価、本番バージョンの構築。本格的な導入を決定する前に、成果をご確認いただけます。

### V20 [UNCHANGED]
- EN question: What do you need from us to start?
- EN answer: A list of your most common call types and questions, your opening hours, where calls should be forwarded and which languages you need. Call samples or scripts help a lot. We do the rest of the setup.
- JA question: 開始にあたって何を提供する必要がありますか？
- JA answer: 最も頻繁にある通話タイプや質問のリスト、営業時間、転送先、必要な言語情報をご提供いただきます。実際の通話サンプルやスクリプトがあると非常にスムーズです。その他の設定は当社で行います。

### V21 [UNCHANGED]
- EN question: How does it connect to our phone number?
- EN answer: We look at how your calls reach you today and agree the simplest way to route them to the agent. This is decided in the first consultation, because every call centre's setup is different.
- JA question: 電話番号とはどのように接続されますか？
- JA answer: 現在の電話の着信方法を確認し、エージェントへルーティングする最もシンプルな方法を協議して決定します。コールセンターごとに設定が異なるため、最初のコンサルティングで決定します。

### V22 [UNCHANGED]
- EN question: How much does it cost?
- EN answer: Pricing depends on call volume, languages and how much integration you need, so we do not publish a fixed price. After a short call we propose a clear quote, starting with a pilot you can evaluate.
- JA question: 料金はいくらかかりますか？
- JA answer: 通話量、言語、必要な統合の度合いによって異なるため、固定料金は公開していません。簡単なヒアリングの後、評価可能なパイロットから始まる明確なお見積もりをご提案いたします。

### V23 [UNCHANGED]
- EN question: Does it work outside call centres?
- EN answer: Yes. Utilities and chain businesses with many repeat calls can use it directly. We focus on call centres first, so that is where we can help you fastest.
- JA question: コールセンター以外でも利用できますか？
- JA answer: はい。繰り返し多い電話が発生するユーティリティ企業やチェーン企業なども直接ご利用いただけます。まずはコールセンターに焦点を当てているため、最速でサポートできる領域となっています。

### V24 [UNCHANGED]
- EN question: Can it connect to our CRM or booking system?
- EN answer: Every call is logged with a summary and status, and a simple booking step can be added. Connecting to your CRM or ticketing system is scoped per project. Tell us which system you use and we will say what is realistic before you commit.
- JA question: CRMや予約システムと連携できますか？
- JA answer: すべての通話は要約とステータスとともに記録され、簡単な予約ステップを追加することも可能です。CRMやチケット管理システムとの連携はプロジェクトごとにスコープを定義します。ご利用中のシステムをお知らせいただければ、導入前に実現可能性をお伝えします。

## E. Websites and ecosystem / ウェブサイトとエコシステム

### W1 [UNCHANGED]
- EN question: What do you offer besides the voice agent?
- EN answer: Three things. The AI voice agent is our main product. We also build a one-week static website, and a full ecosystem: a custom website with its own CMS (editing screen) plus chatbot, voice agent, LINE, social media and booking, built around your business.
- JA question: 音声エージェント以外には何を提供していますか？
- JA answer: 主に3つ提供しています。AI音声エージェントが主力製品ですが、1週間で納品する静的ウェブサイトの構築、およびビジネスに合わせて構築された、専用CMS（編集画面）付きカスタムウェブサイト、チャットボット、音声エージェント、LINE、SNS、予約機能を含んだ完全なエコシステムの構築を行っています。

### W2 [UNCHANGED]
- EN question: What is the one-week website?
- EN answer: A professional static website with clear pages for your services and contact details, delivered in about one week once we have your content and menu. It is the quickest way to get online, and you can upgrade to the full ecosystem later.
- JA question: 「1週間ウェブサイト」とは何ですか？
- JA answer: サービス内容や連絡先を明確に掲載したプロ仕様の静的ウェブサイトで、コンテンツやメニューをご提供いただいてから約1週間で納品されます. オンライン化を最もスピーディーに実現する方法であり、後から完全なエコシステムへアップグレードすることも可能です。

### W3 [UNCHANGED]
- EN question: What is the full ecosystem website?
- EN answer: A custom system built around your business: a website with its own CMS, plus a chatbot, voice agent, LINE, social media and booking. Everything works together, so a customer can read, chat, call or book in one place.
- JA question: 「フルエコシステムウェブサイト」とは何ですか？
- JA answer: お客様のビジネスに合わせて構築されたカスタムシステムです。専用CMS付きウェブサイトに、チャットボット、音声エージェント、LINE、SNS、予約機能が統合されています。すべてが連携しているため、顧客は1つの場所で情報の閲覧、チャット、電話、予約を行うことができます。

### W4 [UNCHANGED]
- EN question: Can I edit the website myself?
- EN answer: On the full ecosystem, yes. The CMS is an admin screen where you update text, photos and news without writing code. Ask us what you can edit on the one-week static site, since it is a simpler build.
- JA question: 自分でウェブサイトを編集できますか？
- JA answer: フルエコシステムの場合は可能です。CMSは管理画面になっており、コードを書かずにテキスト、写真、ニュースを更新できます。1週間静的サイトはよりシンプルな構築となっているため、編集可能な範囲についてはお問い合わせください。

### W5 [UNCHANGED]
- EN question: Which option should I choose?
- EN answer: If missed or overloaded calls are your problem, start with the voice agent. If you just need to be online quickly, choose the one-week website. If you want site, chat, calls and booking working together, choose the ecosystem.
- JA question: どのオプションを選ぶべきですか？
- JA answer: 電話の取りこぼしや過負荷が問題であれば、音声エージェントから始めてください。早急にオンライン上に存在感を示したい場合は、1週間ウェブサイトをお選びください。サイト、チャット、電話、予約を連動させたい場合は、エコシステムをお選びください。

### W6 [UNCHANGED]
- EN question: Do you build online shops?
- EN answer: Not today. Our websites focus on business and service sites with content, enquiries, chat, voice and booking. We do not build e-commerce stores, and we would rather tell you now than waste your time.
- JA question: オンラインショップ（ECサイト）も構築できますか？
- JA answer: 現時点では構築していません。当社のウェブサイトは、コンテンツ、問い合わせ、チャット、音声、予約を備えたビジネスおよびサービスサイトに特化しています。ECストアの構築は行っておりませんので、お時間を無駄にしないよう事前にお伝えしております。

## F. About and contact / 会社概要とお問い合わせ

### C1 [UNCHANGED]
- EN question: Who is TechMirai AI?
- EN answer: TechMirai AI is a Japan-based company building AI voice agents and business websites. Our founders work in Japan with an international engineering team. We focus on practical AI that answers real calls and does real work.
- JA question: TechMirai AIとはどのような会社ですか？
- JA answer: TechMirai AIは、日本を拠点にAI音声エージェントやビジネス用ウェブサイトを開発している企業です。創業者たちは日本を拠点に活動し、国際的なエンジニアチームを擁しています。実際の電話対応を行い、実用的な仕事をする「実践的なAI」に焦点を当てています。

### C2 [UNCHANGED]
- EN question: Do you have customers or case studies?
- EN answer: We are in our early-partner phase and building our first references with call centres. We can show a live demo and walk you through a pilot. We will share case studies once partners agree to be named.
- JA question: 顧客や導入事例はありますか？
- JA answer: 現在はアーリーパートナーフェーズにあり、コールセンター向けに最初の実績を構築している段階です。ライブデモの実施やパイロットのご案内が可能です。パートナー企業からの掲載許可が得られ次第、導入事例を共有いたします。

### C3 [CHANGED]
- EN question: How do I contact you or book a demo?
- EN answer: I can take your name now, and our staff will contact you to arrange a meeting or a demo. You can also email info@techmirai-ai.com or use the contact form on our website, and tell us your call volume, languages and goals.
- JA question: 問い合わせやデモの予約方法を教えてください。
- JA answer: 今すぐお名前をお伺いし、担当者から面談やデモの日程調整のご連絡を差し上げることができます。info@techmirai-ai.com 宛てのメール、またはウェブサイトのお問い合わせフォームからも、通話量、言語、目標をお知らせいただけます。

### C4 [UNCHANGED]
- EN question: Can we talk in English or Japanese?
- EN answer: Yes. We work in both English and Japanese, and our website is available in both. Tell us which you prefer when you write, and we will reply in that language.
- JA question: 英語または日本語でやり取りできますか？
- JA answer: はい。英語と日本語の両方で対応しており、ウェブサイトも両言語でご利用いただけます。お問い合わせの際にご希望の言語をお知らせいただければ、その言語でご返信いたします。

### L1 [NEW]
- EN question: Am I speaking to an AI?
- EN answer: Yes. I am Jenny, an AI voice agent for TechMirai AI. You are hearing the same kind of agent we build for call centres and businesses.
- JA question: AIと話していますか？
- JA answer: はい、私はTechMirai AIのAI音声エージェント、ヒナタです。コールセンターや企業向けに構築している音声エージェントと同じ種類のものです。

### L2 [NEW]
- EN question: Can you transfer me to a person?
- EN answer: I am sorry, I cannot connect you to a person on this line right now. I can take your name, and our staff will contact you on weekdays between 9 a.m. and 6 p.m. Japan time to arrange a meeting.
- JA question: 今すぐ担当者につないでもらえますか？
- JA answer: 申し訳ございません。この回線では、今すぐ担当者におつなぎすることができません。お名前をお伺いし、担当者から平日の午前9時から午後6時（日本時間）の間にご連絡して、面談の日程を調整いたします。

### L3 [NEW]
- EN question: When will your staff contact me?
- EN answer: Our staff will contact you on weekdays between 9 a.m. and 6 p.m. Japan time to arrange a meeting.
- JA question: 担当者からはいつ連絡が来ますか？
- JA answer: 平日の午前9時から午後6時（日本時間）の間に、担当者からご連絡して、面談の日程を調整いたします。
