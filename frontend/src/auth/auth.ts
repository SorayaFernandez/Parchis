export function getToken() {
  return sessionStorage.getItem("token");
}

export function isAuthenticated() {
  return !!sessionStorage.getItem("token");
}

export function logout() {
  sessionStorage.removeItem("token");
}