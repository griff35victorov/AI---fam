export class AiProvider {
  async complete() {
    throw new Error("AiProvider.complete must be implemented by an adapter");
  }
}
