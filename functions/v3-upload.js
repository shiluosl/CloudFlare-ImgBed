export async function onRequestGet({ request }) {
  return Response.redirect(new URL('/?v3=1', request.url), 302);
}
