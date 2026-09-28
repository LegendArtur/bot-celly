// Copy-to-clipboard for attach commands. Optional enhancement only.
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-copy]") : null
  if (!target) return
  const value = target.getAttribute("data-copy") ?? ""
  if (!value) return
  void navigator.clipboard.writeText(value)
  const previous = target.textContent
  target.textContent = "Copied"
  setTimeout(() => { target.textContent = previous }, 1200)
})
