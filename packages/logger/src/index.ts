import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type LoggerService as NestLoggerService,
} from '@nestjs/common';
import pino, { type Logger as PinoLogger } from 'pino';

const PINO_INSTANCE = 'PINO_INSTANCE';

export interface LoggerModuleOptions {
  service?: string;
  level?: string;
  prettyPrint?: boolean;
}

function createPinoInstance(options: LoggerModuleOptions): PinoLogger {
  const isDev = process.env.NODE_ENV !== 'production';
  const usePretty = options.prettyPrint ?? isDev;

  return pino({
    level: options.level ?? (isDev ? 'debug' : 'info'),
    ...(options.service ? { name: options.service } : {}),
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    ...(usePretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
  });
}

@Injectable()
export class BrainLoggerService implements NestLoggerService {
  private readonly logger: PinoLogger;

  constructor(@Inject(PINO_INSTANCE) baseLogger: PinoLogger) {
    this.logger = baseLogger;
  }

  child(context: string): BrainLoggerService {
    const childLogger = this.logger.child({ context });
    return Object.assign(Object.create(BrainLoggerService.prototype), {
      logger: childLogger,
    }) as BrainLoggerService;
  }

  log(message: string, ...optionalParams: unknown[]): void {
    if (optionalParams.length > 0 && typeof optionalParams[0] === 'object') {
      this.logger.info(optionalParams[0] as object, message);
    } else {
      this.logger.info(message);
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (data) {
      this.logger.info(data, message);
    } else {
      this.logger.info(message);
    }
  }

  error(message: string, trace?: string, ...optionalParams: unknown[]): void {
    if (trace) {
      this.logger.error({ err: trace, ...((optionalParams[0] as object) ?? {}) }, message);
    } else {
      this.logger.error(message);
    }
  }

  warn(message: string, ...optionalParams: unknown[]): void {
    if (optionalParams.length > 0 && typeof optionalParams[0] === 'object') {
      this.logger.warn(optionalParams[0] as object, message);
    } else {
      this.logger.warn(message);
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (data) {
      this.logger.debug(data, message);
    } else {
      this.logger.debug(message);
    }
  }

  verbose(message: string, ...optionalParams: unknown[]): void {
    if (optionalParams.length > 0 && typeof optionalParams[0] === 'object') {
      this.logger.trace(optionalParams[0] as object, message);
    } else {
      this.logger.trace(message);
    }
  }

  fatal(message: string, data?: Record<string, unknown>): void {
    if (data) {
      this.logger.fatal(data, message);
    } else {
      this.logger.fatal(message);
    }
  }

  getPinoInstance(): PinoLogger {
    return this.logger;
  }
}

@Global()
@Module({})
export class LoggerModule {
  static forRoot(options: LoggerModuleOptions = {}): DynamicModule {
    const pinoInstance = createPinoInstance(options);

    return {
      module: LoggerModule,
      global: true,
      providers: [
        {
          provide: PINO_INSTANCE,
          useValue: pinoInstance,
        },
        BrainLoggerService,
      ],
      exports: [BrainLoggerService],
    };
  }

  static forService(serviceName: string): DynamicModule {
    return LoggerModule.forRoot({ service: serviceName });
  }
}

export { PINO_INSTANCE };
