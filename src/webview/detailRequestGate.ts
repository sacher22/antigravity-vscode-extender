export interface DetailTicket {
  readonly sessionId: string | undefined;
  readonly agentId: string;
  readonly offset: number;
  readonly token: number;
}

export class DetailRequestGate {
  private selectedSessionId: string | undefined;
  private token: number = 0;
  private activeTicket: DetailTicket | undefined = undefined;

  constructor(initialSessionId?: string | undefined) {
    this.selectedSessionId = initialSessionId;
  }

  public select(sessionId: string | undefined): void {
    if (sessionId === this.selectedSessionId) {
      return;
    }
    this.selectedSessionId = sessionId;
    this.token++;
    this.activeTicket = undefined;
  }

  public get pending(): boolean {
    return this.activeTicket !== undefined;
  }

  public begin(
    sessionId: string | undefined,
    agentId: string,
    offset: number = 0
  ): DetailTicket | undefined {
    if (sessionId !== this.selectedSessionId || this.activeTicket !== undefined) {
      return undefined;
    }

    this.token++;
    const ticket: DetailTicket = Object.freeze({
      sessionId,
      agentId,
      offset,
      token: this.token,
    });
    this.activeTicket = ticket;
    return ticket;
  }

  public current(ticket: DetailTicket): boolean {
    if (!ticket) {
      return false;
    }
    return (
      this.activeTicket !== undefined &&
      this.activeTicket === ticket &&
      ticket.sessionId === this.selectedSessionId &&
      ticket.token === this.token
    );
  }

  public finish(ticket: DetailTicket): boolean {
    if (!this.current(ticket)) {
      return false;
    }
    this.activeTicket = undefined;
    return true;
  }

  public invalidate(): void {
    this.token++;
    this.activeTicket = undefined;
  }
}
