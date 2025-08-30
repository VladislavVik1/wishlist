// types/grammy.d.ts
declare module "grammy" {
    interface Context {
    }
  }
  
  declare global {
    namespace Telegram {
      interface Message {
        photo?: Array<{ file_id: string; file_size: number; width: number; height: number }>;
        caption?: string;
      }
    }
  }