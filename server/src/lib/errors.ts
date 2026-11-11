/** Error con mensaje apto para mostrar al usuario. */
export class UserFacingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
