export class ReadinessState {
  private ready = false;

  markReady(): void {
    this.ready = true;
  }

  markNotReady(): void {
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }
}
