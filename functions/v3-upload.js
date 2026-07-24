export async function onRequestGet({ request }) {
  return Response.redirect(new URL('/v3-upload.html', request.url), 302);
}
