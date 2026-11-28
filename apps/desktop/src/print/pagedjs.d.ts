declare module "pagedjs" {
  export class Previewer {
    preview(
      content: DocumentFragment,
      styles: Record<string, string>[],
      target: HTMLElement,
    ): Promise<unknown>;
  }
}
