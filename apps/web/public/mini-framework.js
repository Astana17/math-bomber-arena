export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

export function on(target, event, handler, options) {
  target.addEventListener(event, handler, options);
  return () => target.removeEventListener(event, handler, options);
}

export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  setProps(el, props);
  append(el, children);
  return el;
}

export function setChildren(parent, children = []) {
  parent.replaceChildren();
  append(parent, children);
}

function setProps(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === "className") {
      el.className = value;
    } else if (key === "text") {
      el.textContent = value;
    } else if (key === "dataset") {
      for (const [dataKey, dataValue] of Object.entries(value)) el.dataset[dataKey] = dataValue;
    } else if (key === "style") {
      for (const [styleKey, styleValue] of Object.entries(value)) el.style[styleKey] = styleValue;
    } else if (key.startsWith("--")) {
      el.style.setProperty(key, value);
    } else if (key.startsWith("aria")) {
      el.setAttribute(key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), value);
    } else {
      el.setAttribute(key, value);
    }
  }
}

function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}
