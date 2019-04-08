import React, { useState } from 'react';
import ReactDOM from 'react-dom';

// Hooks allows you to reuse stateful logic without changing your component hirarchy.

function Example() {
	const [ count, setCount ] = useState(0);

	return (
		<div>
			<p>You clicked {count} times</p>
			<button type="submit" onClick={() => setCount(count + 1)}>
				Click me
			</button>
		</div>
	);
}

const wrapper = document.getElementById('main');
ReactDOM.render(<Example />, wrapper);
