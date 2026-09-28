// dbx-plugin-ssh facade（非上游代码）：loglevel 静音替代。
// 上游 parser 只用 logger.debug/info/warn/error 做诊断输出；浏览器/WebView
// 内不产生控制台噪音，错误经可选钩子交由宿主采集（默认丢弃）。
// API 面与 loglevel 默认导出兼容（仅 vendored 引擎实际用到的子集）。

export interface FigFacadeLogger {
  debug: (...message: unknown[]) => void;
  info: (...message: unknown[]) => void;
  warn: (...message: unknown[]) => void;
  error: (...message: unknown[]) => void;
  setLevel: (level: number | string) => void;
  getLogger: (name?: string) => FigFacadeLogger;
}

type ErrorSink = (message: unknown[]) => void;

let errorSink: ErrorSink | null = null;

/** 注册错误采集钩子（插件侧可选；未注册时丢弃）。 */
export const setParserErrorSink = (sink: ErrorSink | null): void => {
  errorSink = sink;
};

const noop = () => {};

const makeLogger = (): FigFacadeLogger => ({
  debug: noop,
  info: noop,
  warn: noop,
  error: (...message: unknown[]) => {
    try {
      errorSink?.(message);
    } catch {
      /* 采集钩子自身异常绝不外抛 */
    }
  },
  setLevel: noop,
  getLogger: () => makeLogger(),
});

const logger: FigFacadeLogger = makeLogger();
export default logger;
