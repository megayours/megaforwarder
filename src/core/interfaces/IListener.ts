export interface IListener {
  id: string;
  run(): Promise<void>;
}