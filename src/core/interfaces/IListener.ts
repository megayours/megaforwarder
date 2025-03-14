export interface IListener {
  run(): Promise<void>;
}