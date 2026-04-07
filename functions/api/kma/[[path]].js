export async function onRequest(context) {
  const { request, params } = context;
  const pathArray = params.path || [];
  const path = Array.isArray(pathArray) ? pathArray.join('/') : pathArray;
  
  const url = new URL(request.url);
  const targetUrl = `https://apihub.kma.go.kr/${path}${url.search}`;
  
  // Create a new request using the original request's method and headers
  const proxyRequest = new Request(targetUrl, {
    method: request.method,
    headers: request.headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
    redirect: 'follow'
  });
  
  try {
    const response = await fetch(proxyRequest);
    
    // Create a new response to allow us to modify headers (like CORS)
    const newResponse = new Response(response.body, response);
    // Add CORS header so the frontend can read the response safely
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    
    return newResponse;
  } catch (err) {
    return new Response('Error proxying to KMA API', { status: 500 });
  }
}
