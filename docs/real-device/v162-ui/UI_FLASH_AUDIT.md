# UI_FLASH_AUDIT · V16.2 黑白闪屏专项

方法:源码逐项排查(PART 4 的 14 个嫌疑点)+ 浏览器 411px 实测(html/body/page 计算背景 + 主题切换时间采样)+ 静态守卫。
设备受限:真机冷启动首帧(Splash→App)无法在无手机条件下逐帧录屏 ⇒ 真机项标 NOT VERIFIED(见报告)。

## 根因(找到并修复)
1. **主题在脚本末尾才生效(首帧按白色变量绘制)**:旧代码 `applyTheme()` 位于页面脚本最末,
   冷启动必然"先白后黑";且全站元素带 `transition: background-color 500ms ease` —— 连"切主题"都会
   慢慢渐变 500ms。**修复**:head 内联 **pre-paint 脚本**(第一帧前落 `theme-dark` + 内联底色 +
   `html.preload` 禁首屏过渡,两帧后解除)。
2. **pre-paint 内联底色的自然后患(E2E 抓到)**:内联 `backgroundColor` 会压住 CSS 变量,导致
   "切浅色后 html/body 仍是深色"。**修复**:`applyTheme()` 清除内联底色,交还 CSS 变量;
   实测浅色切换:41ms 中间色 → 123ms 过渡中 → **263ms 稳定纯白**,深→浅/浅→深全程无闪切。
3. **原生启动链路白底**:Splash 用 Capacitor 默认白底 PNG,`AppTheme.NoActionBar` 无 windowBackground,
   WebView 自身默认白。**修复(结构层)**:`windowSplashScreenBackground=#0E1013` +
   `postSplashScreenTheme` + `android:windowBackground=#0E1013` + `setBackgroundColor(0xFF0E1013)`。
   与默认主题(App 默认 dark,--bg=#0e1013)一致;切到浅色的用户冷启动首帧仍是深色(系统无法读
   localStorage,**已知边界**,见报告)。
4. **切页双动画**:`.page.active` 的 `pageIn` 与后加的 `.pg-fade` 两条动画叠在同一元素上。
   **修复**:合并为单一 160ms 动画(from opacity .4 + 6px 上移 —— 背景始终是主题底色,不露空帧)。

## 无闪屏守卫(常驻,check-artifacts)
- `V16.2 主题 pre-paint`(head 内联脚本存在 + `html.preload` 规则存在)
- `V16.2 切页单一动画`(无 `.pg-fade`,pageIn ≤200ms)
- `V16.2 无整页跳转`(全文件无 `<a href=` / `location.href=` / `reload()` / `assign()`)
- `V16.2 原生启动背景与默认深色一致`(styles.xml + MainActivity 字节级检查)

## 实测数据(浏览器 411px)
- 冷启后:html/body 背景 = `rgb(14,16,19)`(深色),**无白色中间态**(任何采样点都不是白色)
- 切浅色:41ms `rgb(71,73,75)` → 123ms `rgb(223,223,224)` → 263ms `rgb(255,255,255)`(过渡真实存在且约 200ms)
- 页面切换:E2E 全程截图(`01..08`)中未出现黑帧/白帧;`.page.active` 恒为 1(旧页即时隐藏、新页 160ms 淡入)

## NOT VERIFIED(真机独有)
- 冷启动 Splash→App 首帧序列(需真机录屏逐帧);
- 系统切换深浅模式时 Activity/WebView 背景行为;
- 低端机上的转场掉帧(浏览器与真机 GPU 路径不同)。
