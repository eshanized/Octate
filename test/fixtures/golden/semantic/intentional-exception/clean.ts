export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export function findUser(id: string): string {
  if (!id) {
    throw new NotFoundError("User ID is required");
  }
  return id;
}
