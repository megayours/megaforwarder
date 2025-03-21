export interface IListener {
  id: string;
  run(): Promise<number>;
}