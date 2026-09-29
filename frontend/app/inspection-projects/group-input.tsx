import { useId, useState } from "react";

export function GroupInput({ value, groups, disabled, onChange }: {
  value: string; groups: string[]; disabled: boolean; onChange: (value: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(-1);
  const name = value.trim();
  const options = groups.filter(group => !searching || group.toLowerCase().includes(name.toLowerCase()));
  const creating = !!name && !groups.includes(name);
  const choices = [...options, ...(creating ? [name] : [])];
  function select(group: string) {
    onChange(group);
    setOpen(false);
    setSearching(false);
    setActive(-1);
  }
  return <div className="project-group-input">
    <input className="project-control" role="combobox" aria-label="分组标签" aria-autocomplete="list"
      aria-expanded={open} aria-controls={open ? id : undefined}
      aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
      value={value} disabled={disabled} required maxLength={30} placeholder="选择或输入标签"
      onFocus={() => { setOpen(true); setSearching(false); }}
      onClick={() => setOpen(true)}
      onBlur={() => { setOpen(false); setActive(-1); }}
      onChange={event => { onChange(event.target.value); setSearching(true); setOpen(true); setActive(-1); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
          if (event.key === "Enter") event.preventDefault();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (name) select(open && active >= 0 ? choices[active] : name);
        } else if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          setActive(-1);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setOpen(true);
          setActive(current => {
            if (!choices.length) return -1;
            if (current < 0) return event.key === "ArrowDown" ? 0 : choices.length - 1;
            return (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
          });
        }
      }} />
    {open && <ul id={id} role="listbox" aria-label="分组标签选项" className="project-group-options">
      {choices.map((group, index) => <li key={group} id={`${id}-${index}`} role="option"
        aria-selected={active === index} data-active={active === index}
        onMouseDown={event => event.preventDefault()} onClick={() => select(group)}>
        {creating && index === options.length ? `创建“${group}”（回车）` : group}
      </li>)}
    </ul>}
  </div>;
}
