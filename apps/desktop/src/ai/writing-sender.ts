/** The material a writing connection receives for a text task. */
export interface WritingRequest {
  readonly instruction: string;
  readonly selectedText?: string;
}

export interface WritingReply {
  readonly text: string;
}

/** A configured writing connection ready to handle the same request from setup or the editor. */
export type WritingSender<Reply extends WritingReply = WritingReply> = (
  request: WritingRequest,
) => Promise<Reply>;
