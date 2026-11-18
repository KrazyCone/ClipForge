import { freebuffAuth } from "../../../../lib/freebuff";

export async function GET(request: Request) {
  return freebuffAuth().handlers.GET(request);
}

export async function POST(request: Request) {
  return freebuffAuth().handlers.POST(request);
}
